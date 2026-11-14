// The HTTP server: one process, one store, four protocols. Routes are matched
// here; the REST, GraphQL, MCP and git-protocol work lives in their modules.
// Every response carries X-GitHub-Request-Id and JSON errors, never HTML.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import type { Repo } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  applyPush,
  encodeLsRefs,
  encodePushReport,
  encodeV0Fetch,
  encodeV2Fetch,
  lsRefs,
  parseReceivePack,
  parseV0FetchRequest,
  parseV2FetchArgs,
  parseV2Request,
  planFetch,
  v0ReceiveAdvertisement,
  v0UploadAdvertisement,
  v2Advertisement,
} from './gitproto.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface AppOptions {
  token: string;
}

export function createApp(options: AppOptions): ReturnType<typeof createServer> {
  const store = new Store();
  const expectedToken = options.token;
  let requestSeq = 0;

  // Fetch responses are a pure function of the objects reachable from the
  // wants (objects are immutable and content-addressed), the haves, the
  // shallow boundaries and the depth — so identical fetches share one pack.
  // The refs are part of the key: a push moves a ref and invalidates the entry.
  // Bounded, so a long trial cannot grow it without limit.
  const fetchCache = new Map<string, Buffer>();
  const FETCH_CACHE_MAX = 64;
  const fetchCacheKey = (repo: Repo, protocol: string, wants: readonly string[], haves: readonly string[], shallow: readonly string[], depth: number | null): string =>
    `${repo.id}|${[...repo.refs.entries()].sort().map(([ref, oid]) => `${ref}=${oid}`).join(',')}|${protocol}|${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
  const cachedFetch = (key: string, build: () => Buffer): Buffer => {
    const hit = fetchCache.get(key);
    if (hit !== undefined) return hit;
    const built = build();
    if (fetchCache.size >= FETCH_CACHE_MAX) {
      const oldest = fetchCache.keys().next().value;
      if (oldest !== undefined) fetchCache.delete(oldest);
    }
    fetchCache.set(key, built);
    return built;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': `req-${++requestSeq}`,
      ...headers,
    });
    res.end(payload);
  };

  const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': `req-${++requestSeq}`,
      'content-length': body.length,
    });
    res.end(body);
  };

  const unauthorized = (res: ServerResponse): void => {
    sendJson(res, 401, { message: 'Requires authentication' });
  };

  const isAuthorized = (req: IncomingMessage): boolean => {
    if (expectedToken === '') return true;
    const header = req.headers.authorization;
    if (header === undefined) return false;
    const match = /^Bearer (.+)$/.exec(header);
    return match !== null && match[1] === expectedToken;
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooBig = false;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          tooBig = true;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) reject(new Error('request body too large'));
        else resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });

  const parseJsonBody = (raw: Buffer): { ok: true; value: unknown } | { ok: false } => {
    if (raw.length === 0) return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(raw.toString('utf8')) };
    } catch {
      return { ok: false };
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // Health, no auth.
        if (pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const raw = await readBody(req);
          const parsed = raw.length === 0 ? { ok: true as const, value: null } : parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Malformed JSON body' });
            return;
          }
          const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
          const result = handleRest(
            { method, pathname, query: url.searchParams, body: parsed.value, baseUrl },
            store,
          );
          sendJson(res, result.status, result.body, result.headers);
          return;
        }

        // GraphQL.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
            return;
          }
          const result = handleGraphQL(parsed.value, store);
          sendJson(res, 200, result);
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          const outcome = handleMcp(parsed.ok ? parsed.value : '__PARSE_ERROR__', store);
          if (outcome.body === null) {
            res.writeHead(outcome.status, { 'x-github-request-id': `req-${++requestSeq}` });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const action = gitMatch[3]!;
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          if (owner !== VIEWER_LOGIN) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }

          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const service = url.searchParams.get('service');
            const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            if (service === 'git-upload-pack') {
              if (isV2) sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
              else sendBuffer(res, 200, v0UploadAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, 200, v0ReceiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendJson(res, 400, { message: 'service is required' });
            return;
          }

          if (action === 'git-upload-pack') {
            if (method !== 'POST') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const raw = await readBody(req);
            const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            if (isV2) {
              const parsed = parseV2Request(raw);
              if (parsed === null) {
                sendJson(res, 400, { message: 'Malformed v2 request' });
                return;
              }
              if (parsed.command === 'ls-refs') {
                const prefixes: string[] = [];
                for (const arg of parsed.args) {
                  if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
                }
                sendBuffer(res, 200, encodeLsRefs(lsRefs(repo, prefixes)), 'application/x-git-upload-pack-result');
                return;
              }
              if (parsed.command === 'fetch') {
                const fetchReq = parseV2FetchArgs(parsed.args);
                const key = fetchCacheKey(repo, 'v2', fetchReq.wants, fetchReq.haves, fetchReq.shallow, fetchReq.depth);
                const body = cachedFetch(key, () => {
                  const plan = planFetch(repo, fetchReq.wants, fetchReq.haves, fetchReq.shallow, fetchReq.depth);
                  return encodeV2Fetch(plan);
                });
                sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
                return;
              }
              sendJson(res, 400, { message: `Unsupported command: ${parsed.command}` });
              return;
            }
            const fetchReq = parseV0FetchRequest(raw);
            const key = fetchCacheKey(repo, 'v0', fetchReq.wants, fetchReq.haves, fetchReq.shallow, fetchReq.depth);
            const body = cachedFetch(key, () => {
              const plan = planFetch(repo, fetchReq.wants, fetchReq.haves, fetchReq.shallow, fetchReq.depth);
              return encodeV0Fetch(plan);
            });
            sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
            return;
          }

          if (action === 'git-receive-pack') {
            if (method !== 'POST') {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const raw = await readBody(req);
            const parsed = parseReceivePack(raw);
            if (parsed === null) {
              sendJson(res, 400, { message: 'Malformed receive-pack request' });
              return;
            }
            const result = applyPush(store, repo, parsed.commands, parsed.pack);
            sendBuffer(res, 200, encodePushReport(result), 'application/x-git-receive-pack-result');
            return;
          }

          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never leak a stack or an HTML page: a JSON 500 and the server lives.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } catch {
          // The response may already be on its way; nothing more to do.
        }
      }
    })();
  });

  return server;
}
