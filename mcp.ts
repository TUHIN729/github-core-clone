// MCP: JSON-RPC 2.0 over Streamable HTTP, the modern era (2026-07-28) with a
// legacy initialize fallback. Six tools over the same store the REST, GraphQL
// and git layers share.

import { VIEWER_LOGIN, globalId } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

// ---------------------------------------------------------------- tool definitions

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: repo.refs.get(`refs/heads/${pull.head}`) ?? '' },
    base: { ref: pull.base, sha: repo.refs.get(`refs/heads/${pull.base}`) ?? '' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------- arguments

type Args = Record<string, unknown>;

function argString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argNumber(args: Args, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Split a `full_name` of the form owner/repo into its owner and repo, if given. */
function splitFullName(args: Args): { owner?: string; repo?: string } {
  const fullName = argString(args, 'full_name');
  if (fullName === undefined) return {};
  const slash = fullName.indexOf('/');
  if (slash < 0) return { repo: fullName };
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function repoArgs(args: Args): { owner?: string; repo?: string } {
  const split = splitFullName(args);
  return { owner: argString(args, 'owner') ?? split.owner, repo: argString(args, 'repo', 'name') ?? split.repo };
}

function findRepo(store: Store, owner: string | undefined, repo: string | undefined): Repo | null {
  if (owner === undefined || repo === undefined) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repo) ?? null;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(value: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  const value = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

// ---------------------------------------------------------------- tools

function callTool(store: Store, name: string, args: Args): ToolResult {
  const normalized = name.toLowerCase();
  const tool = TOOLS.find((entry) => entry.name === normalized || normalized.endsWith(`_${entry.name}`) || normalized.endsWith(entry.name));
  if (tool === undefined) return errorResult(`Unknown tool: ${name}`);

  if (tool.name === 'create_repo') {
    const repoName = argString(args, 'name', 'repo');
    if (repoName === undefined) return errorResult('Missing required argument: name');
    if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return errorResult('name is invalid');
    if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return errorResult('Repository already exists');
    const repo = store.createRepo(VIEWER_LOGIN, repoName, {
      description: argString(args, 'description') ?? '',
      isPrivate: args.private === true,
    });
    if (repo === null) return errorResult('Repository already exists');
    return textResult({ repository: repoJson(repo) });
  }

  if (tool.name === 'get_repo') {
    const { owner, repo: repoName } = repoArgs(args);
    if (owner === undefined || repoName === undefined) return errorResult('Missing required arguments: owner and repo');
    const repo = findRepo(store, owner, repoName);
    if (repo === null) return errorResult('Repository not found');
    return textResult({ repository: repoJson(repo) });
  }

  if (tool.name === 'create_issue') {
    const { owner, repo: repoName } = repoArgs(args);
    const title = argString(args, 'title');
    if (owner === undefined || repoName === undefined || title === undefined) {
      return errorResult('Missing required arguments: owner, repo and title');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === null) return errorResult('Repository not found');
    const issue = store.createIssue(repo, title, argString(args, 'body') ?? '', []);
    return textResult({ issue: issueJson(repo, issue) });
  }

  if (tool.name === 'list_issues') {
    const { owner, repo: repoName } = repoArgs(args);
    if (owner === undefined || repoName === undefined) return errorResult('Missing required arguments: owner and repo');
    const repo = findRepo(store, owner, repoName);
    if (repo === null) return errorResult('Repository not found');
    const state = argString(args, 'state') ?? 'open';
    const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
    return textResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
  }

  if (tool.name === 'create_pull_request') {
    const { owner, repo: repoName } = repoArgs(args);
    const title = argString(args, 'title');
    const head = argString(args, 'head', 'headRef', 'head_ref');
    const base = argString(args, 'base', 'baseRef', 'base_ref');
    if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
      return errorResult('Missing required arguments: owner, repo, title, head and base');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === null) return errorResult('Repository not found');
    if (repo.refs.get(`refs/heads/${head}`) === undefined) return errorResult(`head branch does not exist: ${head}`);
    if (repo.refs.get(`refs/heads/${base}`) === undefined) return errorResult(`base branch does not exist: ${base}`);
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
    if (duplicate !== undefined) return errorResult('A pull request already exists for these branches');
    const pull = store.createPull(repo, title, argString(args, 'body') ?? '', head, base);
    return textResult({ pull_request: pullJson(repo, pull) });
  }

  if (tool.name === 'merge_pull_request') {
    const { owner, repo: repoName } = repoArgs(args);
    const pullNumber = argNumber(args, 'pull_number', 'pullNumber', 'number');
    if (owner === undefined || repoName === undefined || pullNumber === undefined) {
      return errorResult('Missing required arguments: owner, repo and pull_number');
    }
    const repo = findRepo(store, owner, repoName);
    if (repo === null) return errorResult('Repository not found');
    const pull = repo.pullByNumber.get(pullNumber);
    if (pull === undefined) return errorResult('Pull request not found');
    if (pull.merged) return errorResult('Pull request has already been merged');
    if (pull.state === 'closed') return errorResult('Pull request is closed');
    if (!store.mergeable(repo, pull)) return errorResult('Merge conflict');
    const merged = store.mergePull(repo, pull);
    if (merged === null) return errorResult('Merge conflict');
    return textResult({ merged: true, sha: merged.sha, number: pull.number, pull_request: pullJson(repo, pull) });
  }

  return errorResult(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------- JSON-RPC

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpOutcome {
  status: number;
  body: unknown;
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleOne(request: unknown, store: Store): JsonRpcResponse | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return errorResponse(null, -32600, 'Invalid Request');
  }
  const { method, params, id } = request as { method?: unknown; params?: unknown; id?: unknown };
  const hasId = id !== undefined && id !== null && (typeof id === 'string' || typeof id === 'number');
  const rpcId: JsonRpcId = hasId ? (id as JsonRpcId) : null;
  if (typeof method !== 'string') {
    return hasId ? errorResponse(rpcId, -32600, 'Invalid Request') : null;
  }
  // Notifications carry no id and get no answer.
  if (!hasId) return null;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return resultResponse(rpcId, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo,
      capabilities: { tools: {} },
      protocolVersion: MODERN_VERSION,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params === 'object' && params !== null ? (params as Record<string, unknown>).protocolVersion : undefined;
    const version = typeof requested === 'string' && (requested === MODERN_VERSION || LEGACY_VERSIONS.includes(requested)) ? requested : LEGACY_VERSIONS[0]!;
    return resultResponse(rpcId, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return resultResponse(rpcId, {});
  }
  if (method === 'tools/list') {
    return resultResponse(rpcId, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return errorResponse(rpcId, -32602, 'Invalid params: tools/call requires an object with name and arguments');
    }
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || name === '') {
      return errorResponse(rpcId, -32602, 'Invalid params: tool name is required');
    }
    const toolArgs = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Args) : {};
    const tool = TOOLS.find((entry) => entry.name === name.toLowerCase() || name.toLowerCase().endsWith(entry.name));
    if (tool === undefined) {
      return errorResponse(rpcId, -32602, `Unknown tool: ${name}`);
    }
    const result = callTool(store, name, toolArgs);
    return resultResponse(rpcId, result);
  }
  return errorResponse(rpcId, -32601, `Method not found: ${method}`);
}

/**
 * Handle one MCP request body. `body` is the already-parsed JSON value, or
 * the sentinel string '__PARSE_ERROR__' when the body was not valid JSON.
 */
export function handleMcp(body: unknown, store: Store): McpOutcome {
  if (body === '__PARSE_ERROR__') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const item of body) {
      const response = handleOne(item, store);
      if (response !== null) responses.push(response);
    }
    return { status: 200, body: responses };
  }
  const response = handleOne(body, store);
  if (response === null) {
    // A notification: no content.
    return { status: 202, body: null };
  }
  return { status: 200, body: response };
}
