# github-core-clone-01 entry

A standalone GitHub-compatible git forge in one Node process, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): smart-HTTP git
clone/push, REST v3 repositories/issues/pulls, GraphQL, and MCP tools, all over
one in-memory store. No UI, no outside service, no git binary, no install
step — the Node standard library only.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. `MAKEFUN_ENV_URL`
names the harness env to register with; `MAKEFUN_SHOP_TOKEN` is the bearer
token the REST, GraphQL, MCP and git routes require (when it is empty, any
bearer is accepted — local development only).

## Layout

- `main.ts` — the entry <-> env lifecycle: bind an ephemeral port, register
  it, poll `/done`, exit 0.
- `app.ts` — the HTTP server and routing: health, REST v3, GraphQL, MCP, and
  the `/{owner}/{repo}.git` smart-HTTP routes. Every response carries
  `X-GitHub-Request-Id` and JSON errors, never HTML.
- `store.ts` — the forge's state: repositories, git objects (sha1, packs,
  trees, commits, three-way merge), issues, pull requests, labels, comments,
  and a deterministic counter clock seeded at the scenario epoch.
- `gitproto.ts` — pkt-lines, v0/v2 advertisements, ls-refs, fetch planning
  (haves, shallow boundaries, deepen), sideband pack delivery, and
  receive-pack with fast-forward checks and report-status.
- `rest.ts` — REST v3: repos, branches, git refs, commits, contents, labels,
  issues, comments, pull requests, files, and squash merge.
- `graphql.ts` — a small GraphQL parser and executor: viewer, repository,
  node, issue/pull-request connections with cursor pagination, introspection,
  and the createIssue / closeIssue / createPullRequest / mergePullRequest /
  addComment mutations.
- `mcp.ts` — MCP over Streamable HTTP: `server/discover` (2026-07-28) with a
  legacy `initialize` fallback, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Determinism

Timestamps come from a counter seeded at the scenario epoch, never from the
wall clock, and global ids are base64 of a typed key, so the same sequence of
requests always produces the same state.
