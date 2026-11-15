# One-process git forge

A GitHub-compatible git forge in a single Node process, standard library only — no
dependencies, no git binary, no outside service.

- **Git smart HTTP**: upload-pack v2 and v0, receive-pack v0, plain-object packfiles with
  OFS/REF delta reading, shallow/deepen fetch semantics, fast-forward push checks.
- **REST v3** under `/api/v3`: repos, branches, commits, contents, labels, issues, pull
  requests (squash merge with conflict detection).
- **GraphQL v4** at `/api/graphql`: viewer, repository, node, issue/pull connections with
  cursor pagination, the five mutations, `__type` introspection.
- **MCP** at `/mcp`: JSON-RPC 2.0, modern era (`server/discover`, revision 2026-07-28)
  plus the legacy `initialize` handshake; six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

All four surfaces share one in-memory store. The scenario is competition-fixed, so the
token owner is the scenario viewer (`adaiversen`); the shop token is opaque and encodes
no login. A repo under any other owner is a 404, never a 403.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, polls `/done`,
and exits 0. For local grading, start the server directly and point the kit's runner
at it:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev-server.ts
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:PORT --token test-token [--perf]
```

## Files

- `main.ts` — entry <-> env lifecycle (bind, register, poll /done, exit).
- `app.ts` — HTTP server, routing, auth, body handling.
- `store.ts` — in-memory store, scenario constants, git object primitives.
- `git.ts` — pkt-lines, pack read/write, upload/receive-pack, fetch selection.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser + executor.
- `mcp.ts` — MCP JSON-RPC handlers and tools.
- `dev-server.ts` — local dev runner (not part of the trial entry point).
