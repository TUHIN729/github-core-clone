// The forge's store: every repository, issue, pull request and git object lives here,
// in memory, for the life of the process. Nothing is read from disk, nothing leaves
// the process, and every timestamp comes from a counter (never the wall clock) so two
// runs that receive the same requests produce the same answers.
//
// The viewer is the login the trial's bearer token names. The scenario the suite
// drives is fixed by one constant seed (wire.ts SCENARIO_SEED), so the viewer login
// is the same in every trial: adaiversen. The store hard-codes that identity rather
// than trusting any request to name it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- identities

/** The login the trial's token names (scenario user 1000, from the fixed seed). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's display name and address, as the scenario builds them. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
/** The scenario's day one: every generated timestamp is this plus a counter. */
export const EPOCH_SEC = 1_735_689_600;

/** A monotonically increasing clock: deterministic across runs of the same requests. */
let clockSeq = 0;
export function tickSec(): number {
  clockSeq += 1;
  return EPOCH_SEC + clockSeq;
}
export function nowIso(): string {
  return new Date(tickSec() * 1000).toISOString();
}

/** The viewer as a GitHub user object (the shape every surface returns). */
export function viewerUser(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_ID),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

// ---------------------------------------------------------------- global ids

/** An opaque, stable Relay id: base64 of a typed key, never the bare database id. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back into [kind, ...parts], or null when it is not one. */
export function parseGlobalId(id: string): [string, string[]] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    // A re-encode must round-trip, so a plain number or a foreign string never parses.
    if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
    return [kind, parts];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- git objects

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** sha1("<type> <len>\0" + data), the object id git computes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte oid, in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(at, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    at = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, sorted the way git sorts them (dirs as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  authorName: string;
  authorEmail: string;
  committer: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
  message: string;
}

/** Split an ident line `Name <email> 1234567890 +0000` into its parts. */
function parseIdent(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return { name: match[1]!, email: match[2]!, timestamp: Number(match[3]) };
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = {
    tree: '',
    parents: [],
    author: '',
    authorName: '',
    authorEmail: '',
    committer: '',
    committerName: '',
    committerEmail: '',
    timestamp: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      view.author = line.slice(7);
      const ident = parseIdent(view.author);
      view.authorName = ident.name;
      view.authorEmail = ident.email;
      view.timestamp = ident.timestamp;
    } else if (line.startsWith('committer ')) {
      view.committer = line.slice(10);
      const ident = parseIdent(view.committer);
      view.committerName = ident.name;
      view.committerEmail = ident.email;
      if (view.timestamp === 0) view.timestamp = ident.timestamp;
    }
  }
  return view;
}

/** Parse a tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

/** Build a commit object: `tree`, `parent` lines, author/committer, blank line, message. */
export function buildCommitObject(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(fields.message, 'utf8')]);
}

/** Walk the commit graph from `roots`, calling `visit` for every reachable commit oid. */
export function walkCommits(
  lookup: (oid: string) => GitObject | undefined,
  roots: readonly string[],
  visit: (oid: string) => void,
): void {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    visit(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
}

/** Every object id reachable from `roots` (commits, their trees and blobs, tag targets). */
export function collectReachable(lookup: (oid: string) => GitObject | undefined, roots: readonly string[]): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (found.has(oid) || !isOid(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    found.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return found;
}

/** True when `ancestor` is reachable from `tip` by following parents (or equal). */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  let found = false;
  walkCommits(lookup, [tip], (oid) => {
    if (oid === ancestor) found = true;
  });
  return found;
}

/** Flatten a tree (at `oid`) into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(lookup: (oid: string) => GitObject | undefined, oid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = lookup(oid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(lookup, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build a tree from a flat path map, creating intermediate trees as needed. */
export function treeFromFlat(
  put: (type: ObjectType, data: Buffer) => string,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

/** The first commit reachable from both `a` and `b` (BFS from `a` over `b`'s ancestors). */
export function mergeBase(
  lookup: (oid: string) => GitObject | undefined,
  a: string,
  b: string,
): string | null {
  const ancestorsB = new Set<string>();
  walkCommits(lookup, [b], (oid) => ancestorsB.add(oid));
  let found: string | null = null;
  const seen = new Set<string>();
  const queue: string[] = [a];
  while (queue.length > 0 && found === null) {
    const oid = queue.shift()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    seen.add(oid);
    if (ancestorsB.has(oid)) {
      found = oid;
      break;
    }
    const object = lookup(oid);
    if (object?.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return found;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read one packfile: every entry resolved to a full object (deltas applied). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at++]!;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjectType;
    let data: Buffer;
    if (typeNum === 6) {
      // OFS_DELTA: the base offset follows as a git varint.
      let offsetByte = pack[at++]!;
      let baseOffset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = pack[at++]!;
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const base = byOffset.get(start - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not an earlier pack entry');
      const delta = inflateFrom(pack, at);
      at = delta.next;
      data = applyDelta(base.data, delta.data);
      type = base.type;
    } else if (typeNum === 7) {
      // REF_DELTA: the base oid follows (20 bytes).
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      const delta = inflateFrom(pack, at);
      at = delta.next;
      data = applyDelta(base.data, delta.data);
      type = base.type;
    } else {
      type = PACK_TYPE[typeNum]!;
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const inflated = inflateFrom(pack, at);
      at = inflated.next;
      data = inflated.data;
      if (data.length !== size) throw new Error(`object size ${data.length} does not match its pack header ${size}`);
    }
    const oid = hashObject(type, data);
    const object: GitObject = { type, data };
    objects.set(oid, object);
    byOffset.set(start, object);
  }
  return objects;
}

/** Inflate one zlib stream starting at `offset`; returns the data and the next offset. */
function inflateFrom(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync with info:true returns {buffer, engine}; engine.bytesWritten is the
  // number of compressed bytes the stream consumed, so the next entry starts there.
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as
    | Buffer
    | { buffer: Buffer; engine: { bytesWritten?: number } };
  if (Buffer.isBuffer(result)) {
    // A Node without the `info` option: find the stream's end by scanning for the
    // first end offset whose slice inflates cleanly to the same bytes.
    const data = result;
    for (let end = offset + 2; end <= buffer.length; end += 1) {
      try {
        if (inflateSync(buffer.subarray(offset, end)).equals(data)) return { data, next: end };
      } catch {
        // not the end yet
      }
    }
    throw new Error('zlib stream did not end');
  }
  const consumed = result.engine.bytesWritten;
  if (typeof consumed !== 'number' || consumed <= 0) throw new Error('zlib stream did not end');
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta to its base, returning the reconstructed object data. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (at < delta.length) {
    const op = delta[at++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= delta[at++]! << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[at++]! << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/** Write a packfile of whole objects (no deltas): header, entries, sha1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNum = { commit: 1, tree: 2, blob: 3, tag: 4 }[object.type];
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- the store

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type PullState = 'open' | 'closed';
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  objectSeq: Map<string, number>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: PullRequest[];
  pullByNumber: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

/** The whole forge: every repository, keyed by owner/name, in creation order. */
export class Store {
  repos = new Map<string, Repo>();
  repoList: Repo[] = [];
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return this.repoList.filter((repo) => repo.owner === owner);
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean }): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      objects: new Map(),
      objectSeq: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.key(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    this.repoList = this.repoList.filter((entry) => entry !== repo);
    return true;
  }

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.objectSeq.set(oid, this.nextSeq());
    }
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Create a commit on `branch` that changes one file, returning its oid. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitOid: string; treeOid: string } {
    // A branch that does not exist yet starts from the default branch's tip
    // (GitHub behaviour: writing to a new branch keeps the other files).
    const tip =
      repo.refs.get(`refs/heads/${branch}`) ??
      (branch === repo.defaultBranch ? undefined : repo.refs.get(`refs/heads/${repo.defaultBranch}`));
    const lookup = this.lookup(repo);
    const baseFlat = tip === undefined ? new Map() : flattenTree(lookup, parseCommit(lookup(tip)!.data).tree);
    if (content === null) {
      baseFlat.delete(path);
    } else {
      const blobOid = this.putObject(repo, 'blob', content);
      baseFlat.set(path, { oid: blobOid, mode: '100644' });
    }
    const treeOid = treeFromFlat((type, data) => this.putObject(repo, type, data), baseFlat);
    const stamp = tickSec();
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommitObject({
        tree: treeOid,
        parents: tip === undefined ? [] : [tip],
        message: message.endsWith('\n') ? message : `${message}\n`,
        author,
        committer: author,
        timestamp: stamp,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, treeOid };
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextIssueNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    return issue;
  }

  /** Append a comment to an issue. */
  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId++,
      body,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    issue.comments.push(comment);
    issue.updatedAt = nowIso();
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
    const number = repo.nextPullNumber++;
    const pull: PullRequest = {
      id: this.nextPullId++,
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      createdSeq: this.nextSeq(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(number, pull);
    return pull;
  }

  /** The three-way merge of a pull request: null when it conflicts. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | null {
    const lookup = this.lookup(repo);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return null;
    if (headTip === baseTip) {
      // Nothing to merge: the squash commit is the base tip itself.
      return { sha: baseTip };
    }
    const base = mergeBase(lookup, headTip, baseTip);
    if (base === null) return null;
    const baseTree = parseCommit(lookup(base)!.data).tree;
    const headTree = parseCommit(lookup(headTip)!.data).tree;
    const targetTree = parseCommit(lookup(baseTip)!.data).tree;
    const baseFlat = flattenTree(lookup, baseTree);
    const headFlat = flattenTree(lookup, headTree);
    const targetFlat = flattenTree(lookup, targetTree);
    const merged = new Map(targetFlat);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = targetFlat.get(path);
      const same = (x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) continue;
      if (same(t, b)) {
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      if (same(h, t)) continue;
      return null; // both sides changed the path differently: conflict
    }
    const treeOid = treeFromFlat((type, data) => this.putObject(repo, type, data), merged);
    const stamp = tickSec();
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const sha = this.putObject(
      repo,
      'commit',
      buildCommitObject({
        tree: treeOid,
        parents: [baseTip],
        message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
        author,
        committer: author,
        timestamp: stamp,
      }),
    );
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = nowIso();
    return { sha };
  }

  /** Whether a pull request would merge cleanly right now. */
  mergeable(repo: Repo, pull: PullRequest): boolean {
    if (pull.merged) return false;
    const lookup = this.lookup(repo);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return false;
    if (headTip === baseTip) return true;
    const base = mergeBase(lookup, headTip, baseTip);
    if (base === null) return false;
    const baseFlat = flattenTree(lookup, parseCommit(lookup(base)!.data).tree);
    const headFlat = flattenTree(lookup, parseCommit(lookup(headTip)!.data).tree);
    const targetFlat = flattenTree(lookup, parseCommit(lookup(baseTip)!.data).tree);
    const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    for (const path of new Set([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()])) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = targetFlat.get(path);
      if (same(h, b) || same(t, b) || same(h, t)) continue;
      return false;
    }
    return true;
  }

  /** The changed files of a pull request (merge-base tree vs head tree), with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const lookup = this.lookup(repo);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (headTip === undefined) return [];
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const base = baseTip === undefined ? null : mergeBase(lookup, headTip, baseTip);
    const baseFlat = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(lookup, parseCommit(lookup(base)!.data).tree);
    const headFlat = flattenTree(lookup, parseCommit(lookup(headTip)!.data).tree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const countLines = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'blob') return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    for (const path of [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort()) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        const additions = countLines(h.oid);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const deletions = countLines(b.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined) {
        const additions = countLines(h.oid);
        const deletions = countLines(b.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }
}
