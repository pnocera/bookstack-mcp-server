# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build
npm run build        # Compile TypeScript to dist/
npm run clean        # Remove dist/

# Development
npm run dev          # Single run with ts-node
npm run watch        # Auto-restart on file changes (nodemon)

# Testing
npm test             # Run Jest tests
npm run test:watch   # Watch mode
npm run test:coverage  # Generate coverage reports

# Linting & Formatting
npm run lint         # ESLint on src/**/*.ts
npm run lint:fix     # Auto-fix ESLint issues
npm run format       # Prettier formatting

# Running a single test file
npx jest tests/unit/books.test.ts

# Docker
docker compose build
docker compose up -d
docker compose logs -f
```

## Architecture

This is a TypeScript **Model Context Protocol (MCP) server** that bridges the BookStack knowledge management system with AI assistants. By default it runs in **public read-only mode** — only 18 read/search/export tools are exposed and write operations are blocked.

### Transport Modes
Two MCP transport modes are supported (configured via `MCP_TRANSPORT`):
- **HTTP** (default): Streamable HTTP for remote connections
- **Stdio**: For local use with Claude Desktop

### Key Source Files

- **`src/server.ts`** — Entry point; `BookStackMCPServer` class that registers tools and resources, handles both transport modes, enforces read-only allowlist, exposes `GET /healthz`
- **`src/tools/read-only-allowlist.ts`** — Single source of truth: `READ_ONLY_TOOL_ALLOWLIST` (`Set<string>`) listing the 18 tools allowed in public mode. Edit this to add/remove read-only tools.
- **`src/api/client.ts`** — Axios-based wrapper around the BookStack REST API; integrates rate limiting; all API calls go through here
- **`src/config/manager.ts`** — Singleton `ConfigManager` using Zod for environment variable validation
- **`src/tools/`** — 14 files, each exporting 3–6 MCP tools (books, pages, chapters, shelves, users, roles, attachments, images, search, permissions, audit, recyclebin, system, server-info)
- **`src/resources/`** — 6 files defining dynamic URI-based MCP resources (e.g., `bookstack://books/{id}`)
- **`src/validation/validator.ts`** — 25+ Zod schemas for all tool inputs
- **`src/utils/`** — `logger.ts` (Winston singleton), `errors.ts` (HTTP status → MCP error code mapping), `rateLimit.ts` (token bucket algorithm)
- **`src/types.ts`** — All TypeScript interfaces

### Read-Only Mode

Controlled by `PUBLIC_READ_ONLY` env var (default: `true`). When enabled:

1. **Registration filter** (`setupTools`): only tools in `READ_ONLY_TOOL_ALLOWLIST` are registered; write-only tool classes (`UserTools`, `RoleTools`, `AttachmentTools`, `ImageTools`, `RecycleBinTools`, `PermissionTools`, `AuditTools`) are not instantiated at all.
2. **Runtime guard** (`CallToolRequestSchema` handler): even if a tool somehow gets registered, calls to anything outside the allowlist return `"Tool disabled on this public read-only server: <name>"`.
3. **Header rejection**: `x-bookstack-url` / `x-bookstack-token` headers return HTTP 400 unless `ALLOW_BOOKSTACK_HEADER_OVERRIDES=true`.
4. **Resource filter** (`setupResources`): `UserResources` is not registered.

`ServerInfoTools` is always instantiated after the tools map is populated so its category/example responses reflect only registered tools.

### Request Flow

1. MCP client invokes a tool (e.g., `bookstack_books_list`)
2. `server.ts` checks `READ_ONLY_TOOL_ALLOWLIST` (if public mode)
3. Tool validates input via Zod schema
4. Validated params passed to `BookStackClient` method
5. Client checks rate limiter (token bucket), then makes HTTP request to BookStack API
6. Response returned as MCP tool result; errors mapped via `errors.ts`

### Configuration

All config from environment variables (see `.env.example`). Required:
- `BOOKSTACK_BASE_URL` — BookStack instance URL (include `/api` suffix)
- `BOOKSTACK_API_TOKEN` — Format: `token_id:token_secret`

Key optional vars:
- `PUBLIC_READ_ONLY` — `true` (default) / `false`
- `ALLOW_BOOKSTACK_HEADER_OVERRIDES` — `false` (default) / `true`
- `PORT` — HTTP port (default: `3000`)
- `MCP_TRANSPORT` — `http` (default) / `stdio`

### Adding a New Read-Only Tool

1. Implement the tool in the appropriate `src/tools/*.ts` file
2. Add its name to `READ_ONLY_TOOL_ALLOWLIST` in `src/tools/read-only-allowlist.ts`
3. Add an API method to `src/api/client.ts` if needed
4. Add types to `src/types.ts` and a Zod schema to `src/validation/validator.ts`

### Docker

`Dockerfile` is a multi-stage build (`node:20-alpine`, non-root user). `docker-compose.yml` sets `PUBLIC_READ_ONLY=true` and `ALLOW_BOOKSTACK_HEADER_OVERRIDES=false` by default. The healthcheck uses `GET /healthz` → `{"ok":true}`.
