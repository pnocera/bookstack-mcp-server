# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

This release modernizes the toolchain around **Bun**, drops the Node.js runtime,
and closes a number of correctness and security defects.

**Breaking changes** — read these before upgrading:

1. **The package runs on Bun** and no longer ships a Node-runnable `dist/` build.
   `npx` / `npm install -g` will not work; use `bunx` / `bun add -g`.
2. **The HTTP transport now requires `MCP_AUTH_TOKEN`** and refuses to start
   without it. `POST /message` dispatches every tool — including permanent
   deletes and user/role operations — using your BookStack admin credential, and
   previously accepted them from anyone who could reach the port. The stdio
   transport is unaffected.
3. **Validation is strict by default** (`VALIDATION_STRICT_MODE=true`). Invalid
   tool parameters are now rejected at the boundary instead of being logged and
   forwarded to BookStack. Set it to `false` for the old permissive behaviour.
4. **`bookstack_images_create` now requires `uploaded_to`** — it was silently
   stripped before, so the call could never have succeeded.

### Added

- HTTP transport now exposes `GET /` (server info) and `GET /health` (returns
  `200` when healthy, `503` otherwise), plus a JSON `404` handler for unknown
  routes. This makes the endpoints described in the setup guide actually work
  and lets container/orchestrator health checks succeed.
- **Inbound authentication for the HTTP transport** (`MCP_AUTH_TOKEN`), compared
  in constant time and checked *before* the request body is parsed. The
  transport fails closed: there is no "no auth" mode.
- **A configurable request body limit** (`HTTP_BODY_LIMIT`, default 70 MiB).
  Express's ~100 KB default silently capped inline uploads at roughly 75 KB and
  answered anything larger with a `413` raised before MCP dispatch — while the
  tools advertised a limit 600× higher.
- `GET /health` now coalesces concurrent probes into a single upstream check
  (5s TTL, bounded waiters), so unauthenticated readiness traffic cannot crowd
  out authenticated tool calls or spend the BookStack budget without limit.
- Multi-stage **Bun** `Dockerfile` (`oven/bun` base) that runs the TypeScript
  source directly, with a `/health`-based `HEALTHCHECK`.
- `docker-compose.yml` running BookStack + MariaDB + the MCP server for
  real-world local testing.
- Integration test suite that runs against a real BookStack instance, with an
  API token provisioned automatically (BookStack normally only allows creating
  tokens through its web UI). A plain `bun test` **skips** the live suite when
  BookStack isn't reachable, so it passes without Docker; `bun run test:integration`
  sets `RUN_INTEGRATION=1` and **fails loudly** if the stack is missing, so an
  explicit integration run can never pass vacuously. See
  `docs/integration-testing.md`.
- GitHub Actions CI running typecheck, tests, and lint on push and pull request.
- `CHANGELOG.md` (this file).

### Changed

- **Runtime & tooling migrated from Node.js to Bun**: execution, package
  manager (`bun.lock` replaces `package-lock.json`), and the test runner
  (`bun test`). The package is now ESM (`"type": "module"`) and the entry point
  uses `import.meta.main`.
- **Linting/formatting switched from ESLint + Prettier to [Biome]**. The
  previous `npm run lint` was broken (no ESLint config); Biome now lints and
  formats via `bun run lint` / `bun run format`.
- **All dependencies upgraded to their latest versions**, including TypeScript
  7, Zod 4, Express 5, and `@modelcontextprotocol/sdk` 1.29. `tsconfig.json`
  updated for TypeScript 7 (`moduleResolution: bundler`, removed `baseUrl`).
- All `any` types across the tool/resource handlers replaced with `unknown` at
  the dynamic boundary and the concrete param interfaces from `src/types.ts`.
- `LOG_LEVEL` and `LOG_FORMAT` now genuinely drive the logger through config.
  Previously the logger read the environment directly and ignored the validated
  config, so `LOG_FORMAT` had no effect and an invalid `LOG_LEVEL` passed
  silently. Invalid values are now rejected at startup.
- **`VALIDATION_STRICT_MODE` now defaults to `true`.** Previously validation was
  advisory: a schema violation was logged as a warning and the *original*
  parameters were forwarded to BookStack anyway. Invalid parameters are now
  rejected at the boundary with a clear error. Set `VALIDATION_STRICT_MODE=false`
  to restore the permissive behaviour.
- The recycle-bin restore and permanent-delete tools now report `restore_count` /
  `delete_count`. The recycle bin is top-level only — deleting a book with a
  chapter and a page creates **one** entry, and restoring it brings back all
  three — so the count is the only signal of how much was affected. It was
  previously discarded.

### Removed

- **Node.js support and the `tsc` build step.** The package no longer publishes
  a compiled `dist/` for Node consumers; it runs on Bun.
- Build output (`dist/`) is no longer tracked in git.
- Unused dependencies: `compression`, `cors`, `helmet`, `uuid`, and `supertest`
  (the first three were configured but never wired into the Express app).
- Node-only dev dependencies: `jest`, `ts-jest`, `ts-node`, `nodemon`,
  `rimraf`, and their `@types`.

### Fixed

- Health/root endpoints returning `404` under the HTTP transport.
- `dotenv` printed an "injected env" banner to **stdout**, which corrupted the
  JSON-RPC stream under the stdio transport. It is now silenced: in stdio mode
  stdout carries **only** MCP protocol messages — no banner and no log lines
  (all logging goes to stderr).
- The Claude Desktop integration examples omitted `MCP_TRANSPORT=stdio`. Because
  the transport defaults to `http`, following the documented config started an
  HTTP server that Claude could not connect to.
- Documentation described features that do not exist: a `config.json` file,
  `retryAttempts`/`retryDelay`, a `features` block, `ENABLE_METRICS`/
  `METRICS_PORT`/`HEALTH_CHECK_PORT`, a multi-instance `instances` array, a
  `--version` flag, and a log file at `/var/log/bookstack-mcp.log` (the logger
  only ever wrote to stderr). All removed.
- Zod 4 renamed `ZodError.errors` to `ZodError.issues`. The error handler still
  read `.errors`, so **any Zod validation error reaching it crashed** with
  `TypeError: Cannot read properties of undefined` (reachable via strict
  validation mode). Both the error handler and config validation now read
  `.issues`.
- The API client documented "retry logic" but never retried — `isRetryable()`
  was dead code with no callers, so BookStack's rate limit (180 requests/minute
  per user) surfaced as a hard failure. Requests now genuinely retry transient
  failures, honouring `Retry-After` / `X-RateLimit-Reset`, bounded by an attempt
  and total-wait budget. `429` retries any verb (the request was rejected before
  executing); `5xx` only retries idempotent verbs.
- The six export tools declared they return `{content, filename, mime_type}` but
  actually returned the raw response body, so `.content` was always `undefined`.
  PDF exports were additionally corrupted by text-decoding binary data (an 879KB
  PDF inflated to 1.5MB of replacement characters). Exports now return a
  populated result, with `encoding` and `byte_length` so binary content is
  unambiguous.
- `parseInt` calls now pass an explicit radix.

#### Tools that silently returned the wrong results

- **`pages_list`'s `draft` and `template` filters returned the opposite of what
  was asked.** The boolean was serialized as the string `"true"`, which MySQL
  coerces to `0` against BookStack's `tinyint` columns — so `draft: true`
  matched `draft = 0` and returned non-drafts. No error was raised.
  **`roles_list`'s `mfa_enforced` filter** had the identical bug.
- **`search`'s advertised `{tag:name=value}` syntax does not exist.** BookStack
  silently drops an unrecognised `{filter:…}` term rather than erroring, so the
  query degraded to match-all — the documented example `{tag:status=active}`
  returned *every* item while appearing to filter. The real syntax is
  `[name=value]`. Likewise `{type:shelf}` matched nothing (the token is
  `bookshelf`).
- **`audit_log_list` sorted oldest-first** while documenting "most recent first".
- **`name` filters are exact-match, not partial**, on books, chapters, pages,
  images, attachments and shelves — all six documented "partial match", so a
  search for a fragment returned nothing.

#### Tools that never worked

- **`usage_examples` returned `{error: 'Workflow not found'}` for every value it
  advertised** — the lookup matched against titles, and no title contained the
  underscore its enum values use.
- **`help` advertised six topics but implemented three**; the other three
  returned `guidance: undefined`. Its contextual advice recommended
  `bookstack_search_all`, which does not exist.
- **`images_create` could never succeed**: `uploaded_to` is required by BookStack
  but was silently stripped by validation.

#### Parameters that were silently discarded

- `roles_list.filter`, `users_create`/`users_update.external_auth_id`,
  `images_list.filter.uploaded_to`, `chapters_list.filter.created_by` and
  `audit_log_list`'s date filters were all advertised and supported by BookStack,
  but omitted from the validation schemas — so they were stripped, and callers
  received unfiltered results that looked like successful queries.
- **`users.email` and `users.external_auth_id` were silently truncated** at 191
  characters (the underlying column limit) with no error — an over-long email
  lost its domain. Both are now rejected at the boundary.

#### Capabilities and parameters that did not exist

- **`users_update.active`** — BookStack has no such field or column. The call
  succeeded and did nothing, while the tool's own example was "Deactivate a
  user". Removed; the description now explains the real alternative.
- **`roles_delete.migrate_ownership_id`** — BookStack's role-delete accepts no
  body, so the user was left with no roles rather than migrated. Removed.
  (`users_delete.migrate_ownership_id` is real and was kept.)
- **`roles_create`/`roles_update.permissions`** advertised an object of booleans;
  BookStack requires an array of strings, so the documented example always
  returned `422`.
- **`server_info`** advertised resource URIs that could never resolve, and
  reported `supports_batch_operations: true` and `supports_caching: true` for
  features that do not exist. **`tool_categories`** omitted 5 of the 56 tools.
- Advertised length limits contradicted BookStack's real ones (role description
  1000 vs 180; image name 255 vs 180; user name 255 vs 100), guaranteeing a
  `422` at the boundary values the tools claimed to accept.

#### Logging

- **Plaintext passwords, page content and whole upload payloads were written to
  the logs at the default level.** The tool boundary logged its raw arguments, so
  creating a user wrote the new account's password, and an image upload
  duplicated its entire base64 payload into container logs. Log metadata is now
  an **allowlist**: a string is withheld unless its key proves it safe, and a key
  naming a credential is never rendered at all — not even its length. Search
  queries, names and emails are reported as lengths.
- URLs are sanitized structurally wherever they appear (userinfo removed,
  credential-bearing query values replaced), rather than by matching key names —
  a URL carries its credentials *inside* the value, where no key rule can see
  them.
- A rejected `BOOKSTACK_BASE_URL` is no longer quoted back in the error. It named
  the setting and the offending component, but a base URL's path is arbitrary
  operator text that can carry a proxy capability.
- `dotenv` and a stray `console.log` wrote to **stdout**, which corrupts the
  JSON-RPC stream under the stdio transport. Nothing in the process writes to
  stdout now except MCP protocol messages.

#### Rate limiting

- **`RATE_LIMIT_*` never bound on the HTTP transport.** Every `POST /message`
  built a new client with a fresh token bucket, so each request received a fresh
  burst allowance. The limiter is now shared per outbound identity (base URL +
  token), so the configured budget is a real ceiling. Equivalent spellings of the
  same URL resolve to one bucket; distinct credentials stay isolated.

#### Response types that described fields BookStack does not return

- `SystemInfo` declared eight fields (`php_version`, `theme`, `timezone`, …) that
  BookStack does not return; `ContentPermissions`, `AuditLogEntry` and
  `RecycleBinItem` all had wrong field names; `tags` was declared always-present
  but is absent from every list response. The API client casts responses without
  checking, so none of this failed loudly — it surfaced as `undefined`.
- `validation.enabled` used `config.validation?.enabled || true`, which can never
  be `false`, so the server could not report validation as disabled.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Biome]: https://biomejs.dev/
[Unreleased]: https://github.com/pnocera/bookstack-mcp-server/compare/v1.0.0...HEAD
