// REST v3: repositories, branches, commits, contents, labels, issues, comments
// and pull requests, in the shape the GitHub API returns them.

import {
  VIEWER_LOGIN,
  flattenTree,
  globalId,
  hashObject,
  isOid,
  nowIso,
  parseCommit,
  parseTag,
  parseTree,
  walkCommits,
} from './store.ts';
import type { Comment, Issue, Label, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- plumbing

export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({ status, body, headers });
const err = (status: number, message: string): RestResponse => ({ status, body: { message } });
const noContent = (): RestResponse => ({ status: 204, body: null });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, pathname: string): { page: T[]; link: string } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const linkFor = (p: number, rel: string): string => {
    const url = new URL(pathname, baseUrl);
    for (const [key, value] of query) url.searchParams.set(key, value);
    url.searchParams.set('page', String(p));
    url.searchParams.set('per_page', String(perPage));
    return `<${url.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(totalPages, 'last'));
  return { page: pageItems, link: links.join(', ') };
}

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/repos/${repo.owner}/${repo.name}`,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged || pull.state === 'closed' ? false : store.mergeable(repo, pull),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const date = new Date(commit.timestamp * 1000).toISOString();
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      // GitHub returns the message without the trailing newline the object carries.
      message: commit.message.replace(/\n$/, ''),
      author: { name: commit.authorName, email: commit.authorEmail, date },
      committer: { name: commit.committerName, email: commit.committerEmail, date },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------- repo lookup

function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

// Resolve a ref parameter (branch name, full ref, or oid) to a commit oid.
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object?.type === 'commit') return ref;
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target) && repo.objects.get(target)?.type === 'commit') return target;
    }
  }
  return null;
}

/** The tree oid of `path` under `rootTreeOid`, or null when it is not a tree. */
function findTreeOid(repo: Repo, rootTreeOid: string, path: string): string | null {
  const parts = path.split('/').filter((part) => part !== '');
  let current = rootTreeOid;
  for (const part of parts) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((item) => item.name === part);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- the router

export function handleRest(request: RestRequest, store: Store): RestResponse {
  const { method, pathname, query, body } = request;
  const segments = pathname.split('/').filter((part) => part.length > 0);
  // Everything here lives under /api/v3.
  if (segments[0] !== 'api' || segments[1] !== 'v3') return err(404, 'Not Found');
  const rest = segments.slice(2);
  const bodyObj = isRecord(body) ? body : {};

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      200,
      {
        current_user_url: `${request.baseUrl}/api/v3/user`,
        repository_url: `${request.baseUrl}/api/v3/repos/{owner}/{repo}`,
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: VIEWER_LOGIN, id: 1000, type: 'User', name: 'ada iversen', email: 'adaiversen@example.invalid' });
  }

  // /api/v3/user/repos
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const name = bodyString(bodyObj, 'name');
      if (name === undefined || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: bodyString(bodyObj, 'description') ?? '',
        isPrivate: bodyObj.private === true,
      });
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos, query, request.baseUrl, pathname);
      return ok(200, page.map(repoJson), { Link: link });
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]!);
    const repoName = decodeURIComponent(rest[2]!);
    const repo = findRepo(store, owner, repoName);
    if (repo === null) return err(404, 'Not Found');
    const tail = rest.slice(3);

    // The repo itself.
    if (tail.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        if (bodyString(bodyObj, 'description') !== undefined) repo.description = bodyString(bodyObj, 'description')!;
        if (typeof bodyObj.default_branch === 'string' && repo.refs.has(`refs/heads/${bodyObj.default_branch}`)) {
          repo.defaultBranch = bodyObj.default_branch;
        }
        repo.updatedAt = nowIso();
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return noContent();
      }
      return err(404, 'Not Found');
    }

    // Branches.
    if (tail[0] === 'branches') {
      if (tail.length === 1) {
        if (method !== 'GET') return err(404, 'Not Found');
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return ok(200, branches);
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(tail[1]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Branch not found');
        return ok(200, { name: branch, ref: `refs/heads/${branch}`, commit: { sha }, object: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = bodyString(bodyObj, 'ref');
        const sha = bodyString(bodyObj, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return err(422, 'ref and sha are required');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (object === undefined || object.type !== 'commit') return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        repo.updatedAt = nowIso();
        return ok(201, { ref, object: { sha }, node_id: globalId('Ref', `${repo.id}:${ref}`) });
      }
      if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = decodeURIComponent(tail.slice(3).join('/'));
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    // Commits.
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return err(404, 'Not Found');
      const ref = query.get('sha');
      const tip = resolveRef(repo, ref);
      if (tip === null) return ok(200, []);
      const shas: string[] = [];
      walkCommits(
        (oid) => repo.objects.get(oid),
        [tip],
        (oid) => shas.push(oid),
      );
      // Newest first, by commit timestamp (the deterministic counter makes
      // every timestamp distinct, so this order is total).
      shas.sort((a, b) => {
        const ta = parseCommit(repo.objects.get(a)!.data).timestamp;
        const tb = parseCommit(repo.objects.get(b)!.data).timestamp;
        return tb - ta;
      });
      const { page } = paginate(shas, query, request.baseUrl, pathname);
      return ok(
        200,
        page.map((sha) => commitJson(repo, sha)).filter((entry) => entry !== null),
      );
    }

    // Contents.
    if (tail[0] === 'contents') {
      const path = decodeURIComponent(tail.slice(1).join('/'));
      if (method === 'GET') {
        const ref = query.get('ref');
        const tip = resolveRef(repo, ref);
        if (tip === null) return err(404, 'Not Found');
        const commit = repo.objects.get(tip);
        if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
        const treeOid = parseCommit(commit.data).tree;
        const flat = flattenTree((oid) => repo.objects.get(oid), treeOid);
        const file = flat.get(path);
        if (file !== undefined) {
          const blob = repo.objects.get(file.oid)!;
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop(),
            path,
            sha: hashObject('blob', blob.data),
            content: blob.data.toString('base64'),
          });
        }
        // A directory: the entries directly under it.
        const prefix = path === '' ? '' : `${path}/`;
        const entries: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        for (const [filePath, entry] of [...flat.entries()].sort()) {
          if (!filePath.startsWith(prefix)) continue;
          const rest2 = filePath.slice(prefix.length);
          const first = rest2.split('/')[0]!;
          if (seen.has(first)) continue;
          seen.add(first);
          if (rest2.includes('/')) {
            const tree = findTreeOid(repo, treeOid, prefix + first);
            entries.push({ type: 'dir', size: 0, name: first, path: prefix + first, sha: tree ?? '' });
          } else {
            const blob = repo.objects.get(entry.oid)!;
            entries.push({ type: 'file', size: blob.data.length, name: first, path: filePath, sha: hashObject('blob', blob.data) });
          }
        }
        if (entries.length === 0) return err(404, 'Not Found');
        return ok(200, entries);
      }
      if (method === 'PUT') {
        const message = bodyString(bodyObj, 'message') ?? 'Update file';
        const contentB64 = bodyString(bodyObj, 'content');
        if (contentB64 === undefined) return err(422, 'content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(400, 'content is not valid base64');
        }
        const branch = bodyString(bodyObj, 'branch') ?? repo.defaultBranch;
        const sha = bodyString(bodyObj, 'sha');
        const baseOid = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const flat = new Map<string, { oid: string; mode: string }>();
        if (baseOid !== undefined) {
          const commit = repo.objects.get(baseOid);
          if (commit !== undefined && commit.type === 'commit') {
            const treeOid = parseCommit(commit.data).tree;
            for (const [filePath, entry] of flattenTree((oid) => repo.objects.get(oid), treeOid)) flat.set(filePath, entry);
          }
        }
        const existing = flat.get(path);
        if (existing !== undefined) {
          if (sha === undefined) return err(422, 'sha was not supplied');
          if (sha !== existing.oid) return err(409, 'sha does not match the current file');
        }
        const isCreate = existing === undefined;
        const { commitOid } = store.commitFile(repo, branch, path, content, message);
        const blobOid = hashObject('blob', content);
        return ok(isCreate ? 201 : 200, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitOid, message },
        });
      }
      if (method === 'DELETE') {
        const message = bodyString(bodyObj, 'message') ?? 'Delete file';
        const branch = bodyString(bodyObj, 'branch') ?? repo.defaultBranch;
        const baseOid = repo.refs.get(`refs/heads/${branch}`);
        if (baseOid === undefined) return err(404, 'Not Found');
        const commit = repo.objects.get(baseOid);
        if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
        const treeOid = parseCommit(commit.data).tree;
        const flat = flattenTree((oid) => repo.objects.get(oid), treeOid);
        if (!flat.has(path)) return err(404, 'Not Found');
        const { commitOid } = store.commitFile(repo, branch, path, null, message);
        return ok(200, { commit: { sha: commitOid, message }, content: null });
      }
      return err(404, 'Not Found');
    }

    // Labels.
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        return ok(200, [...repo.labels.values()].map(labelJson));
      }
      if (tail.length === 1 && method === 'POST') {
        const name = bodyString(bodyObj, 'name');
        if (name === undefined || name === '') return err(422, 'name is required');
        if (repo.labels.has(name)) return err(422, 'Label already exists');
        const color = bodyString(bodyObj, 'color') ?? '000000';
        const description = bodyString(bodyObj, 'description') ?? '';
        const label: Label = { id: repo.nextLabelId++, name, color, description };
        repo.labels.set(name, label);
        return ok(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }

    // Issues.
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let issues = [...repo.issues];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          const direction = query.get('direction') ?? 'desc';
          const sort = query.get('sort') ?? 'created';
          issues.sort((a, b) => {
            const byNumber = a.number - b.number;
            const byTime = a.createdSeq - b.createdSeq;
            const cmp = sort === 'created' ? byTime || byNumber : byNumber;
            return direction === 'asc' ? cmp : -cmp;
          });
          const { page, link } = paginate(issues, query, request.baseUrl, pathname);
          return ok(200, page.map((issue) => issueJson(repo, issue)), { Link: link });
        }
        if (method === 'POST') {
          const title = bodyString(bodyObj, 'title');
          if (title === undefined || title === '') return err(422, 'title is required');
          const rawLabels = bodyObj.labels;
          const labelNames: string[] = Array.isArray(rawLabels)
            ? rawLabels.map((label) => (typeof label === 'string' ? label : (label as { name?: string }).name ?? '')).filter((name) => name !== '')
            : [];
          const labels: Label[] = [];
          for (const name of labelNames) {
            const label = repo.labels.get(name);
            if (label === undefined) return err(422, `Label does not exist: ${name}`);
            labels.push(label);
          }
          const issue = store.createIssue(repo, title, bodyString(bodyObj, 'body') ?? '', labels);
          return ok(201, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const issue = repo.issueByNumber.get(number);
      if (tail.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          if (bodyString(bodyObj, 'state') === 'closed' || bodyString(bodyObj, 'state') === 'open') {
            issue.state = bodyString(bodyObj, 'state') as 'open' | 'closed';
            issue.closedAt = issue.state === 'closed' ? nowIso() : null;
          }
          if (bodyString(bodyObj, 'title') !== undefined) issue.title = bodyString(bodyObj, 'title')!;
          if (bodyString(bodyObj, 'body') !== undefined) issue.body = bodyString(bodyObj, 'body')!;
          issue.updatedAt = nowIso();
          return ok(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, issue.comments.map(commentJson));
        }
        if (method === 'POST') {
          const text = bodyString(bodyObj, 'body');
          if (text === undefined || text === '') return err(422, 'body is required');
          const comment = store.addComment(repo, issue, text);
          return ok(201, commentJson(comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // Pull requests.
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let pulls = [...repo.pulls];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(pulls, query, request.baseUrl, pathname);
          return ok(200, page.map((pull) => pullJson(store, repo, pull)), { Link: link });
        }
        if (method === 'POST') {
          const title = bodyString(bodyObj, 'title');
          const head = bodyString(bodyObj, 'head');
          const base = bodyString(bodyObj, 'base');
          if (title === undefined || head === undefined || base === undefined) return err(422, 'title, head and base are required');
          if (repo.refs.get(`refs/heads/${head}`) === undefined) return err(422, `head branch does not exist: ${head}`);
          if (repo.refs.get(`refs/heads/${base}`) === undefined) return err(422, `base branch does not exist: ${base}`);
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
          if (duplicate !== undefined) return err(422, 'A pull request already exists for these branches');
          const pull = store.createPull(repo, title, bodyString(bodyObj, 'body') ?? '', head, base);
          return ok(201, pullJson(store, repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pullByNumber.get(number);
      if (tail.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return err(404, 'Not Found');
      }
      if (tail[2] === 'files' && tail.length === 3) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        return ok(200, store.pullFiles(repo, pull));
      }
      if (tail[2] === 'merge' && tail.length === 3) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.merged) return err(405, 'Pull request has already been merged');
        if (pull.state === 'closed') return err(405, 'Pull request is closed');
        const mergeMethod = bodyString(bodyObj, 'merge_method') ?? 'squash';
        if (mergeMethod !== 'squash') return err(422, 'only squash merges are supported');
        if (!store.mergeable(repo, pull)) return err(405, 'Merge conflict');
        const merged = store.mergePull(repo, pull);
        if (merged === null) return err(405, 'Merge conflict');
        return ok(200, { sha: merged.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
