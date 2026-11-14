// GraphQL: a small parser and executor for the fixed document set the sealed
// suite sends — viewer/repository/node queries, issue and pull-request
// connections with cursor pagination, introspection, and the five mutations.
// No external dependency: the tokenizer and the recursive-descent parser are
// written here, and the executor resolves against the store.

import {
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  nowIso,
  parseGlobalId,
} from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- values

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string };

interface Selection {
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
  fragment?: { typeCondition: string | null };
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue?: GqlValue }>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { type: 'name'; value: string }
  | { type: 'int'; value: string }
  | { type: 'float'; value: string }
  | { type: 'string'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'spread'; value: '...' }
  | { type: 'var'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ type: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ('{}()[]!:=@&|'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  skipPunct(value: string): boolean {
    const token = this.peek();
    if (token?.type === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next?.type === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.value} at document top level`);
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): Record<string, { defaultValue?: GqlValue }> {
    const out: Record<string, { defaultValue?: GqlValue }> = {};
    if (!this.skipPunct('(')) return out;
    while (!this.skipPunct(')')) {
      const varToken = this.next();
      if (varToken.type !== 'var') throw new Error('expected a variable');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: GqlValue | undefined;
      if (this.skipPunct('=')) defaultValue = this.parseValue();
      out[varToken.value] = { defaultValue };
    }
    return out;
  }

  parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  skipDirectives(): void {
    while (this.peek()?.type === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.type === 'punct' && this.peek()!.value === '(') this.parseArguments();
    }
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): Selection {
    const token = this.peek()!;
    if (token.type === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.type === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        return { alias: '', name: '', args: {}, selections, fragment: { typeCondition } };
      }
      if (next?.type === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { alias: '', name: '', args: {}, selections: [], fragment: { typeCondition: `@${name}` } };
      }
      this.skipDirectives();
      return { alias: '', name: '', args: {}, selections: this.parseSelectionSet(), fragment: { typeCondition: null } };
    }
    // A field, optionally aliased.
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.peek()?.type === 'punct' && this.peek()!.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections = this.peek()?.type === 'punct' && this.peek()!.value === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (!this.skipPunct('(')) return args;
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.type === 'var') return { kind: 'var', name: token.value };
    if (token.type === 'string') return token.value;
    if (token.type === 'int') return Number(token.value);
    if (token.type === 'float') return Number(token.value);
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { kind: 'enum', value: token.value };
    }
    if (token.type === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return items;
    }
    if (token.type === 'punct' && token.value === '{') {
      const obj: { [key: string]: GqlValue } = {};
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      return obj;
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

export function parseGraphQL(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
}

type NodeValue =
  | { typename: 'Query'; store: Store }
  | { typename: 'User'; login: string }
  | { typename: 'Repository'; repo: Repo }
  | { typename: 'Issue'; repo: Repo; issue: Issue }
  | { typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { typename: 'PullRequest'; store: Store; repo: Repo; pull: PullRequest }
  | { typename: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[] }
  | { typename: 'FileConnection'; files: Array<{ filename: string; status: string; additions: number; deletions: number }> }
  | { typename: 'File'; file: { filename: string; status: string; additions: number; deletions: number } }
  | { typename: 'Ref'; name: string }
  | { typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { typename: 'TypeInfo'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { typename: 'TypeField'; name: string }
  | { typename: 'EnumValue'; name: string }
  | { typename: 'TypeRef'; name: string; kind: string }
  | { typename: 'Payload'; fields: Record<string, NodeValue | string | number | boolean | null> }
  | { typename: 'Comment'; comment: { id: number; body: string } };

function resolveValue(value: GqlValue, ctx: Ctx): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, ctx));
  if ('kind' in value) {
    if (value.kind === 'enum') return value.value;
    if (value.kind === 'var') return ctx.variables[value.name] ?? null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item as GqlValue, ctx);
  return out;
}

function argValue(selection: Selection, name: string, ctx: Ctx): unknown {
  const raw = selection.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, ctx);
}

function argString(selection: Selection, name: string, ctx: Ctx): string | undefined {
  const value = argValue(selection, name, ctx);
  return typeof value === 'string' ? value : undefined;
}

function argNumber(selection: Selection, name: string, ctx: Ctx): number | undefined {
  const value = argValue(selection, name, ctx);
  return typeof value === 'number' ? value : undefined;
}

/** Expand fragments and inline fragments into the fields of one level. */
function collectFields(selections: readonly Selection[], ctx: Ctx, typename: string): Selection[] {
  const out: Selection[] = [];
  const seen = new Map<string, Selection>();
  const push = (selection: Selection): void => {
    const existing = seen.get(selection.alias);
    if (existing !== undefined) {
      existing.selections.push(...selection.selections);
      return;
    }
    seen.set(selection.alias, selection);
    out.push(selection);
  };
  for (const selection of selections) {
    if (selection.fragment !== undefined) {
      const condition = selection.fragment.typeCondition;
      if (condition !== null && condition.startsWith('@')) {
        const def = ctx.fragments.get(condition.slice(1));
        if (def !== undefined && def.typeCondition === typename) {
          for (const inner of collectFields(def.selections, ctx, typename)) push(inner);
        }
        continue;
      }
      if (condition === null || condition === typename) {
        for (const inner of collectFields(selection.selections, ctx, typename)) push(inner);
      }
      continue;
    }
    push(selection);
  }
  return out;
}

function unknownField(ctx: Ctx, typename: string, name: string): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${typename}".` });
  return null;
}

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(store: Store, repo: Repo, pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveNode(node: NodeValue, selections: readonly Selection[], ctx: Ctx): Record<string, unknown> | null {
  const fields = collectFields(selections, ctx, node.typename);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field.alias] = resolveField(node, field, ctx);
  }
  return out;
}

/** Resolve one connection edge: `cursor` is a scalar, `node` carries its own selections. */
function resolveEdge(selections: readonly Selection[], ctx: Ctx, cursor: string, node: NodeValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of collectFields(selections, ctx, 'Edge')) {
    if (field.name === 'cursor') out[field.alias] = cursor;
    else if (field.name === 'node') out[field.alias] = resolveNode(node, field.selections, ctx);
    else {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Edge".` });
      out[field.alias] = null;
    }
  }
  return out;
}

function resolveField(node: NodeValue, field: Selection, ctx: Ctx): unknown {
  const name = field.name;
  switch (node.typename) {
    case 'Query': {
      if (name === 'viewer') {
        return resolveNode({ typename: 'User', login: VIEWER_LOGIN }, field.selections, ctx);
      }
      if (name === 'repository') {
        const owner = argString(field, 'owner', ctx);
        const repoName = argString(field, 'name', ctx);
        if (owner !== VIEWER_LOGIN) return null;
        const repo = owner === undefined || repoName === undefined ? undefined : ctx.store.getRepo(owner, repoName);
        if (repo === undefined) return null;
        return resolveNode({ typename: 'Repository', repo }, field.selections, ctx);
      }
      if (name === 'node') {
        const id = argString(field, 'id', ctx);
        if (id === undefined) return null;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        const [kind, parts] = parsed;
        if (kind === 'Repository') {
          const repo = ctx.store.repoList.find((entry) => entry.id === Number(parts[0]));
          if (repo === undefined) return null;
          return resolveNode({ typename: 'Repository', repo }, field.selections, ctx);
        }
        if (kind === 'Issue') {
          const found = findIssue(ctx.store, Number(parts[0]));
          if (found === null) return null;
          return resolveNode({ typename: 'Issue', repo: found.repo, issue: found.issue }, field.selections, ctx);
        }
        if (kind === 'PullRequest') {
          const found = findPull(ctx.store, Number(parts[0]));
          if (found === null) return null;
          return resolveNode({ typename: 'PullRequest', store: ctx.store, repo: found.repo, pull: found.pull }, field.selections, ctx);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argString(field, 'name', ctx);
        if (typeName === undefined) return null;
        const info = typeInfo(typeName);
        if (info === null) return null;
        return resolveNode(info, field.selections, ctx);
      }
      if (name === '__schema') {
        return resolveNode(
          { typename: 'Payload', fields: { types: null, queryType: null, mutationType: null } },
          field.selections,
          ctx,
        );
      }
      return unknownField(ctx, 'Query', name);
    }
    case 'User': {
      if (name === 'login') return node.login;
      if (name === 'id') return globalId('User', node.login === VIEWER_LOGIN ? 1000 : 0);
      if (name === 'name') return VIEWER_NAME;
      if (name === 'email') return VIEWER_EMAIL;
      return unknownField(ctx, 'User', name);
    }
    case 'Repository': {
      const repo = node.repo;
      if (name === 'id') return globalId('Repository', repo.id);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.isPrivate;
      if (name === 'owner') return resolveNode({ typename: 'User', login: repo.owner }, field.selections, ctx);
      if (name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return resolveNode({ typename: 'Ref', name: repo.defaultBranch }, field.selections, ctx);
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'createdAt') return repo.createdAt;
      if (name === 'updatedAt') return repo.updatedAt;
      if (name === 'issue') {
        const number = argNumber(field, 'number', ctx);
        if (number === undefined) return null;
        const issue = repo.issueByNumber.get(number);
        if (issue === undefined) return null;
        return resolveNode({ typename: 'Issue', repo, issue }, field.selections, ctx);
      }
      if (name === 'issues') return resolveIssues(repo, field, ctx);
      if (name === 'pullRequests') {
        const first = argNumber(field, 'first', ctx) ?? 30;
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
        return resolveNode({ typename: 'PullRequestConnection', repo, pulls }, field.selections, ctx);
      }
      if (name === 'pullRequest') {
        const number = argNumber(field, 'number', ctx);
        if (number === undefined) return null;
        const pull = repo.pullByNumber.get(number);
        if (pull === undefined) return null;
        return resolveNode({ typename: 'PullRequest', store: ctx.store, repo, pull }, field.selections, ctx);
      }
      return unknownField(ctx, 'Repository', name);
    }
    case 'Issue': {
      const issue = node.issue;
      if (name === 'id') return globalId('Issue', issue.id);
      if (name === 'databaseId') return issue.id;
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'state') return issueState(issue.state);
      if (name === 'body') return issue.body;
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'author') return resolveNode({ typename: 'User', login: VIEWER_LOGIN }, field.selections, ctx);
      if (name === 'repository') return resolveNode({ typename: 'Repository', repo: node.repo }, field.selections, ctx);
      return unknownField(ctx, 'Issue', name);
    }
    case 'IssueConnection': {
      if (name === 'nodes') {
        return node.issues.map((issue) => resolveNode({ typename: 'Issue', repo: node.repo, issue }, field.selections, ctx));
      }
      if (name === 'edges') {
        return node.issues.map((issue) => resolveEdge(field.selections, ctx, encodeCursor(issue.number), { typename: 'Issue', repo: node.repo, issue }));
      }
      if (name === 'pageInfo') {
        return resolveNode(
          { typename: 'PageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor, hasPreviousPage: false, startCursor: node.issues.length > 0 ? encodeCursor(node.issues[0]!.number) : null },
          field.selections,
          ctx,
        );
      }
      if (name === 'totalCount') return node.issues.length;
      return unknownField(ctx, 'IssueConnection', name);
    }
    case 'PullRequest': {
      const pull = node.pull;
      if (name === 'id') return globalId('PullRequest', pull.id);
      if (name === 'databaseId') return pull.id;
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pullState(node.store, node.repo, pull);
      if (name === 'merged') return pull.merged;
      if (name === 'headRefName') return pull.head;
      if (name === 'baseRefName') return pull.base;
      if (name === 'headRef') return resolveNode({ typename: 'Ref', name: pull.head }, field.selections, ctx);
      if (name === 'baseRef') return resolveNode({ typename: 'Ref', name: pull.base }, field.selections, ctx);
      if (name === 'mergeable') {
        if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
        return node.store.mergeable(node.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (name === 'createdAt') return pull.createdAt;
      if (name === 'updatedAt') return pull.updatedAt;
      if (name === 'author') return resolveNode({ typename: 'User', login: VIEWER_LOGIN }, field.selections, ctx);
      if (name === 'files') {
        const first = argNumber(field, 'first', ctx) ?? 30;
        const files = node.store.pullFiles(node.repo, pull).slice(0, first);
        return resolveNode({ typename: 'FileConnection', files }, field.selections, ctx);
      }
      return unknownField(ctx, 'PullRequest', name);
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') {
        return node.pulls.map((pull) => resolveNode({ typename: 'PullRequest', store: ctx.store, repo: node.repo, pull }, field.selections, ctx));
      }
      if (name === 'edges') {
        return node.pulls.map((pull) => resolveEdge(field.selections, ctx, encodeCursor(pull.number), { typename: 'PullRequest', store: ctx.store, repo: node.repo, pull }));
      }
      if (name === 'pageInfo') {
        return resolveNode(
          { typename: 'PageInfo', hasNextPage: false, endCursor: node.pulls.length > 0 ? encodeCursor(node.pulls[node.pulls.length - 1]!.number) : null, hasPreviousPage: false, startCursor: null },
          field.selections,
          ctx,
        );
      }
      if (name === 'totalCount') return node.pulls.length;
      return unknownField(ctx, 'PullRequestConnection', name);
    }
    case 'FileConnection': {
      if (name === 'nodes') {
        return node.files.map((file) => resolveNode({ typename: 'File', file }, field.selections, ctx));
      }
      if (name === 'totalCount') return node.files.length;
      if (name === 'pageInfo') {
        return resolveNode({ typename: 'PageInfo', hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, field.selections, ctx);
      }
      return unknownField(ctx, 'FileConnection', name);
    }
    case 'File': {
      if (name === 'path') return node.file.filename;
      if (name === 'additions') return node.file.additions;
      if (name === 'deletions') return node.file.deletions;
      return unknownField(ctx, 'File', name);
    }
    case 'Ref': {
      if (name === 'name') return node.name;
      if (name === 'id') return globalId('Ref', node.name);
      return unknownField(ctx, 'Ref', name);
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return node.hasNextPage;
      if (name === 'endCursor') return node.endCursor;
      if (name === 'hasPreviousPage') return node.hasPreviousPage;
      if (name === 'startCursor') return node.startCursor;
      return unknownField(ctx, 'PageInfo', name);
    }
    case 'TypeInfo': {
      if (name === 'name') return node.name;
      if (name === 'kind') return node.kind;
      if (name === 'description') return null;
      if (name === 'fields') {
        return node.fields.map((fieldName) => resolveNode({ typename: 'TypeField', name: fieldName }, field.selections, ctx));
      }
      if (name === 'enumValues') {
        return node.enumValues.map((value) => resolveNode({ typename: 'EnumValue', name: value }, field.selections, ctx));
      }
      return unknownField(ctx, '__Type', name);
    }
    case 'TypeField': {
      if (name === 'name') return node.name;
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'type') return resolveNode({ typename: 'TypeRef', name: 'String', kind: 'SCALAR' }, field.selections, ctx);
      return unknownField(ctx, '__Field', name);
    }
    case 'EnumValue': {
      if (name === 'name') return node.name;
      if (name === 'description') return null;
      return unknownField(ctx, '__EnumValue', name);
    }
    case 'TypeRef': {
      if (name === 'name') return node.name;
      if (name === 'kind') return node.kind;
      if (name === 'ofType') return null;
      return unknownField(ctx, '__Type', name);
    }
    case 'Payload': {
      const value = node.fields[name];
      if (value === undefined) return unknownField(ctx, 'Payload', name);
      if (value !== null && typeof value === 'object' && 'typename' in (value as Record<string, unknown>)) {
        return resolveNode(value as NodeValue, field.selections, ctx);
      }
      return value;
    }
    case 'Comment': {
      if (name === 'id') return globalId('IssueComment', node.comment.id);
      if (name === 'databaseId') return node.comment.id;
      if (name === 'body') return node.comment.body;
      return unknownField(ctx, 'IssueComment', name);
    }
    default:
      return unknownField(ctx, node.typename, name);
  }
}

function resolveIssues(repo: Repo, field: Selection, ctx: Ctx): Record<string, unknown> | null {
  const first = argNumber(field, 'first', ctx);
  const after = argString(field, 'after', ctx);
  const states = argValue(field, 'states', ctx);
  const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  let issues = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(issueState(issue.state)));
  }
  const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
  issues.sort((a, b) => {
    const byNumber = a.number - b.number;
    const byTime = a.createdSeq - b.createdSeq;
    const cmp = byTime || byNumber;
    return direction === 'asc' ? cmp : -cmp;
  });
  const afterNumber = decodeCursor(after);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const hasNextPage = first !== undefined && issues.length > first;
  const page = first === undefined ? issues : issues.slice(0, first);
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return resolveNode({ typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor }, field.selections, ctx);
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  Ref: ['id', 'name'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeInfo(name: string): NodeValue | null {
  const fields = TYPE_FIELDS[name];
  if (fields !== undefined) {
    return { typename: 'TypeInfo', name, kind: 'OBJECT', fields, enumValues: [] };
  }
  const enumValues = TYPE_ENUMS[name];
  if (enumValues !== undefined) {
    return { typename: 'TypeInfo', name, kind: 'ENUM', fields: [], enumValues };
  }
  return null;
}

// ---------------------------------------------------------------- lookups

function findIssue(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repoList) {
    const issue = repo.issues.find((entry) => entry.id === id);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPull(store: Store, id: number): { repo: Repo; pull: PullRequest } | null {
  for (const repo of store.repoList) {
    const pull = repo.pulls.find((entry) => entry.id === id);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function inputObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------- mutations

function executeMutation(operation: Operation, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = collectFields(operation.selections, ctx, 'Mutation');
  for (const field of fields) {
    const input = inputObject(argValue(field, 'input', ctx));
    const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
    if (field.name === 'createIssue') {
      const repositoryId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = repositoryId !== null && repositoryId[0] === 'Repository'
        ? ctx.store.repoList.find((entry) => entry.id === Number(repositoryId[1][0]))
        : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
        out[field.alias] = null;
        continue;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repo, title, body, []);
      out[field.alias] = resolveNode(
        { typename: 'Payload', fields: { issue: { typename: 'Issue', repo, issue }, clientMutationId } },
        field.selections,
        ctx,
      );
      continue;
    }
    if (field.name === 'closeIssue') {
      const issueId = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      const found = issueId !== null && issueId[0] === 'Issue' ? findIssue(ctx.store, Number(issueId[1][0])) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided issueId.' });
        out[field.alias] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = nowIso();
      found.issue.updatedAt = nowIso();
      out[field.alias] = resolveNode(
        { typename: 'Payload', fields: { issue: { typename: 'Issue', repo: found.repo, issue: found.issue }, clientMutationId } },
        field.selections,
        ctx,
      );
      continue;
    }
    if (field.name === 'createPullRequest') {
      const repositoryId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = repositoryId !== null && repositoryId[0] === 'Repository'
        ? ctx.store.repoList.find((entry) => entry.id === Number(repositoryId[1][0]))
        : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the provided repositoryId.' });
        out[field.alias] = null;
        continue;
      }
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (repo.refs.get(`refs/heads/${headRefName}`) === undefined || repo.refs.get(`refs/heads/${baseRefName}`) === undefined) {
        ctx.errors.push({ message: 'Head or base ref does not exist.' });
        out[field.alias] = null;
        continue;
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === headRefName && pull.base === baseRefName);
      if (duplicate !== undefined) {
        ctx.errors.push({ message: 'A pull request already exists for these branches.' });
        out[field.alias] = null;
        continue;
      }
      const pull = ctx.store.createPull(repo, title, body, headRefName, baseRefName);
      out[field.alias] = resolveNode(
        { typename: 'Payload', fields: { pullRequest: { typename: 'PullRequest', store: ctx.store, repo, pull }, clientMutationId } },
        field.selections,
        ctx,
      );
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const pullRequestId = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      const found = pullRequestId !== null && pullRequestId[0] === 'PullRequest' ? findPull(ctx.store, Number(pullRequestId[1][0])) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided pullRequestId.' });
        out[field.alias] = null;
        continue;
      }
      if (found.pull.merged || found.pull.state === 'closed') {
        ctx.errors.push({ message: 'Pull request is already closed.' });
        out[field.alias] = null;
        continue;
      }
      if (!ctx.store.mergeable(found.repo, found.pull)) {
        ctx.errors.push({ message: 'Merge conflict.' });
        out[field.alias] = null;
        continue;
      }
      const merged = ctx.store.mergePull(found.repo, found.pull);
      if (merged === null) {
        ctx.errors.push({ message: 'Merge conflict.' });
        out[field.alias] = null;
        continue;
      }
      out[field.alias] = resolveNode(
        { typename: 'Payload', fields: { pullRequest: { typename: 'PullRequest', store: ctx.store, repo: found.repo, pull: found.pull }, clientMutationId } },
        field.selections,
        ctx,
      );
      continue;
    }
    if (field.name === 'addComment') {
      const subjectId = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      const found = subjectId !== null && subjectId[0] === 'Issue' ? findIssue(ctx.store, Number(subjectId[1][0])) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the provided subjectId.' });
        out[field.alias] = null;
        continue;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = ctx.store.addComment(found.repo, found.issue, body);
      out[field.alias] = resolveNode(
        {
          typename: 'Payload',
          fields: {
            commentEdge: { typename: 'Payload', fields: { node: { typename: 'Comment', comment }, cursor: encodeCursor(comment.id) } },
            clientMutationId,
          },
        },
        field.selections,
        ctx,
      );
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    out[field.alias] = null;
  }
  return out;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function handleGraphQL(body: unknown, store: Store): GraphQLResponse | GraphQLResponse[] {
  if (Array.isArray(body)) {
    return body.map((item) => handleSingle(item, store));
  }
  return handleSingle(body, store);
}

function handleSingle(body: unknown, store: Store): GraphQLResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'Request body must be a JSON object with a query field.' }] };
  }
  const { query, variables, operationName } = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let document: Document;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error.' }] };
  }
  const operation =
    typeof operationName === 'string'
      ? document.operations.find((entry) => entry.name === operationName)
      : document.operations[0];
  if (operation === undefined) {
    return { errors: [{ message: `Unknown operation named "${String(operationName)}".` }] };
  }
  const vars: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(operation.variables)) {
    if (def.defaultValue !== undefined) vars[name] = resolveValue(def.defaultValue, { store, variables: {}, errors: [], fragments: document.fragments });
  }
  if (typeof variables === 'object' && variables !== null && !Array.isArray(variables)) {
    for (const [key, value] of Object.entries(variables as Record<string, unknown>)) vars[key] = value;
  }
  const ctx: Ctx = { store, variables: vars, errors: [], fragments: document.fragments };
  if (operation.kind === 'mutation') {
    const data = executeMutation(operation, ctx);
    return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
  }
  const data = resolveNode({ typename: 'Query', store }, operation.selections, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
