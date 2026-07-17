# BookStack MCP Server

Connect BookStack to Claude and other AI assistants through the Model Context Protocol (MCP). This server exposes 56 tools and 11 resources covering the supported subset of the BookStack API — books, pages, chapters, shelves, search, users, roles, permissions, attachments, images, the recycle bin, the audit log and system info.

This server supports two transport modes: **Streamable HTTP** (default) and **Stdio**.

- **Streamable HTTP (default)**: A stateless HTTP transport. Authentication parameters can be overridden per-request using HTTP headers (`x-bookstack-url` and `x-bookstack-token`).
- **Stdio Mode**: Standard input/output for local integration (e.g., with Claude Desktop). Set `MCP_TRANSPORT=stdio` to enable.

> ⚠️ **Looking for the HTTP endpoint?** The MCP endpoint is `POST /message` — not `/`.
> See [Transports](#-transports) and [HTTP endpoints](#http-endpoints) below.

## ✨ What You Get

- **BookStack Integration** - Access your books, pages, chapters, and content
- **56 MCP Tools & 11 Resources** - CRUD, search and export across the supported endpoint families
- **Search & Export** - Find content and export in multiple formats
- **User Management** - Handle users, roles, and permissions
- **Production Ready** - Rate limiting, validation, error handling, and logging

## 🚀 Quick Start

> ⚠️ **Requires [Bun](https://bun.sh) 1.1.0 or newer. Node.js is not supported.**
> This package ships TypeScript source rather than a compiled bundle, and its
> executable starts with `#!/usr/bin/env bun` — Bun must be installed on the
> machine that runs it. `npx`/`npm install -g` will not work.

Configure first — the default HTTP transport **refuses to start** until both tokens
below are set:

```bash
# 1. Configure
export BOOKSTACK_BASE_URL="https://your-bookstack.com/api"
export BOOKSTACK_API_TOKEN="token_id:token_secret"   # OUTBOUND: the credential this server spends
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"      # INBOUND: who may make it spend that credential

# 2. Run without installing (starts the HTTP server on port 3000)
bunx bookstack-mcp-server

# Or install globally, then run it by name
bun add -g bookstack-mcp-server
bookstack-mcp-server
```

The two tokens are **not** interchangeable and must not be set to the same value:
`BOOKSTACK_API_TOKEN` is what the server presents to BookStack; `MCP_AUTH_TOKEN` is
what callers must present to `POST /message`, which dispatches all 56 tools with the
authority of the BookStack account behind `BOOKSTACK_API_TOKEN`. Skip `MCP_AUTH_TOKEN`
only for [stdio](#-transports), which has no network surface and ignores it.

**Check it started:**

```bash
curl http://localhost:3000/          # => {"status":"running", ...}
curl -i http://localhost:3000/health # => 200 healthy, or 503 if BookStack is unreachable
```

### Add to Claude

To use with Claude Desktop (requires Stdio mode):

```bash
# For Claude Code
claude mcp add bookstack bunx bookstack-mcp-server \
  --env BOOKSTACK_BASE_URL=https://your-bookstack.com/api \
  --env BOOKSTACK_API_TOKEN=token_id:token_secret \
  --env MCP_TRANSPORT=stdio
```

### Configuration

Set these environment variables:

```bash
export BOOKSTACK_BASE_URL="https://your-bookstack.com/api"
export BOOKSTACK_API_TOKEN="token_id:token_secret"

# Required for the HTTP transport (the default); ignored by stdio.
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"

# Optional: transport mode — "http" (default) or "stdio"
export MCP_TRANSPORT="http"
```

> 💡 **Token Format**: Combine your BookStack Token ID and Token Secret as `token_id:token_secret`

#### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `http` | Transport mode. Only the exact value `stdio` selects stdio; **any other value (or unset) starts the HTTP server**. |
| `MCP_AUTH_TOKEN` | _(none — **required** for HTTP)_ | **Inbound** secret callers must present as `Authorization: Bearer <value>` on `POST /message`. The HTTP transport **refuses to start** without it — there is no "no auth" mode. Unrelated to `BOOKSTACK_API_TOKEN`, and must not be the same value. Ignored in stdio mode. Generate with `openssl rand -hex 32`. |
| `BOOKSTACK_BASE_URL` | `http://localhost:8080/api` | Full URL to the BookStack API. Must be a valid URL and include the `/api` suffix. |
| `BOOKSTACK_API_TOKEN` | _(none — required)_ | **Outbound** BookStack API token as `token_id:token_secret`. This is the credential the server spends on every tool call. Startup fails if unset. |
| `BOOKSTACK_TIMEOUT` | `30000` | BookStack request timeout in milliseconds. |
| `SERVER_PORT` | `3000` | Port the HTTP transport listens on. Ignored in stdio mode. |
| `HTTP_BODY_LIMIT` | `73400320` (70 MiB) | Maximum accepted `POST /message` body, in bytes. Sized for the largest inline base64 upload the image/attachment tools advertise (50,000 KB). Express's own default is ~100 KB, which would reject real uploads with a `413`. Lower it if untrusted callers can reach the port. |
| `SERVER_NAME` | `bookstack-mcp-server` | Server name reported over MCP and by `GET /`. |
| `SERVER_VERSION` | the package's own version | Version reported over MCP `initialize`, by `GET /`, and by `bookstack_server_info`. Defaults to `package.json#version`; leave it unset unless you deliberately want a different value. |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `60` | Outbound rate limit toward BookStack. |
| `RATE_LIMIT_BURST_LIMIT` | `10` | Outbound burst allowance toward BookStack. |
| `VALIDATION_ENABLED` | `true` | Input validation. Set to `false` to disable. |
| `VALIDATION_STRICT_MODE` | `true` | Reject invalid tool params at the boundary. Set to `false` to log a warning and forward them to BookStack instead. |
| `LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`. |
| `LOG_FORMAT` | `pretty` | One of `json`, `pretty`. |
| `NODE_ENV` | `development` | One of `development`, `production`, `test`. |
| `DEBUG` | `false` | Set to `true` for debug output. |

> 💡 Need detailed setup? See the complete [Setup Guide](docs/setup-guide.md)

## 🔌 Transports

The transport is chosen at startup from `MCP_TRANSPORT`:

| `MCP_TRANSPORT` | Result |
| --- | --- |
| unset (**default**) | Streamable HTTP server on `SERVER_PORT` (default `3000`) |
| `http` | Same as unset |
| `stdio` | Stdio transport — reads MCP messages from stdin |

**Stdio is opt-in.** If you do not set `MCP_TRANSPORT=stdio`, you get the HTTP server.

### HTTP endpoints

When running in HTTP mode the server exposes exactly three endpoints. Any other
path returns a JSON `404` listing the valid ones.

| Method & path | Purpose | Status codes |
| --- | --- | --- |
| `GET /` | Server info JSON (name, version, `status: "running"`, endpoint list) | `200` |
| `GET /health` | Health check — verifies live connectivity to BookStack | `200` healthy, `503` unhealthy |
| `POST /message` | **The MCP endpoint.** Send JSON-RPC MCP messages here | `200`, `401` without a valid bearer token, `500` on error |

`GET /` and `GET /health` are unauthenticated. **`POST /message` requires an inbound
`Authorization: Bearer <secret>` header** — it dispatches every tool, including
permanent-delete and user/role operations, so the HTTP transport refuses to start
without a secret configured. The startup error names the exact variable to set; the
`stdio` transport has no network surface and needs none.

**Check the server is up:**

```bash
curl http://localhost:3000/
```

```json
{
  "name": "bookstack-mcp-server",
  "version": "1.0.0",
  "status": "running",
  "mcp": true,
  "endpoints": {
    "health": "/health",
    "message": "/message (POST, requires an Authorization: Bearer header)"
  },
  "documentation": "Send MCP protocol messages to POST /message"
}
```

**Check health:**

```bash
curl -i http://localhost:3000/health
```

`/health` verifies live connectivity to BookStack, so a **wrong** token returns `503`
with the failing check named:

```json
{
  "status": "unhealthy",
  "checks": [
    { "name": "bookstack_connection", "healthy": false, "message": "BookStack API connection" },
    { "name": "tools_loaded", "healthy": true, "message": "56 tools loaded" },
    { "name": "resources_loaded", "healthy": true, "message": "11 resources loaded" }
  ]
}
```

> ⚠️ A **missing** `BOOKSTACK_API_TOKEN` behaves differently: config validation rejects
> an empty token at startup, so the process exits with
> `Configuration validation failed: bookstack.apiToken: BookStack API token is required`
> before Express ever listens. There is no `/health` to call — `curl` gets a connection
> refused, and under Docker the container restart-loops. A `503` therefore always means
> the token is **present but not working**; a dead port means it is **absent**.

**Call the MCP endpoint** — an `initialize` handshake. Both the `Content-Type`
and `Accept` headers are required by the Streamable HTTP transport, and
`Authorization` carries the same `MCP_AUTH_TOKEN` you exported in the quick start:

```bash
# Fail fast rather than sending an empty bearer header and puzzling over a 401.
: "${MCP_AUTH_TOKEN:?export MCP_AUTH_TOKEN first — the inbound secret this server was started with}"

curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0.0" }
    }
  }'
```

Per-request credential overrides are supported on `POST /message` via the
`x-bookstack-url` and `x-bookstack-token` headers; both fall back to the
`BOOKSTACK_BASE_URL` / `BOOKSTACK_API_TOKEN` environment variables.

### Using with n8n

Point n8n's MCP client at the `/message` path — not the root URL:

```
http://<host>:3000/message
```

Use the host as n8n sees it: `http://localhost:3000/message` when n8n runs on
the same machine, or the container/service name (e.g. `http://mcp:3000/message`)
when both run in Docker on a shared network.

### Running stdio in Docker

A stdio MCP server reads requests from **stdin** — so `docker run` without `-i`
gives it no stdin, stdin hits EOF immediately, and the container exits on
startup. Pass `-i` to keep stdin attached:

```bash
docker run -i --rm \
  -e MCP_TRANSPORT=stdio \
  -e BOOKSTACK_BASE_URL=https://your-bookstack.com/api \
  -e BOOKSTACK_API_TOKEN=token_id:token_secret \
  bookstack-mcp-server
```

Use `-i` alone, **not** `-it`: allocating a TTY breaks the JSON-RPC stream that
MCP clients pipe over stdin/stdout. For stdio you also don't need `-p 3000:3000`
— nothing listens on a port in stdio mode.

> If your container "starts then dies immediately" with `MCP_TRANSPORT=stdio`,
> a missing `-i` is almost always the cause.

## 🛠️ Available Tools

**56 tools across 13 categories:**

- **📚 Books** (6) - Create, read, update, delete, and export books
- **📄 Pages** (6) - Manage pages with HTML/Markdown content
- **📑 Chapters** (6) - Organize pages within books
- **📚 Shelves** (5) - Group books into collections
- **🔍 Search** (1) - Search across content types
- **👥 Users** (5) - User account management
- **🎭 Roles** (5) - Roles and their permissions
- **⚙️ System** (2) - Instance info and the audit log
- **🔐 Permissions** (2) - Content access control
- **🗑️ Recycle Bin** (3) - Deleted item recovery
- **📎 Attachments** (5) - File attachments
- **🖼️ Images** (5) - Image gallery
- **🧭 Meta** (5) - Ask the server about its own tools and conventions

Not exposed (no tools): comments, imports, tag-name listings, the image-gallery
`data` endpoints, and `zip` export.

> 📖 See the complete [Tools Overview](docs/tools-overview.md) for detailed documentation

## 📚 Documentation

Find comprehensive guides in the `docs/` folder:

- **[Setup Guide](docs/setup-guide.md)** - Complete installation and configuration
- **[API Reference](docs/api-reference.md)** - Supported tools/endpoints with examples
- **[Tools Overview](docs/tools-overview.md)** - Every tool explained
- **[Resources Guide](docs/resources-guide.md)** - Resource access patterns
- **[Examples & Workflows](docs/examples-and-workflows.md)** - Real-world usage
- **[Integration Testing](docs/integration-testing.md)** - Running the live suite against a real BookStack
- **[Releasing](docs/releasing.md)** - How versions are cut and published

## ⚡ Quick Examples

**List all books:**
```javascript
bookstack_books_list({ count: 10, sort: "updated_at" })
```

**Create a new page:**
```javascript
bookstack_pages_create({
  name: "Getting Started",
  book_id: 1,
  markdown: "# Welcome\nYour content here..."
})
```

**Search for content:**
```javascript
bookstack_search({ query: "API documentation", count: 20 })
```

## 🛠️ Development

This project is Bun-native — Bun runs the TypeScript source directly, so there is
no compile step.

```bash
git clone <repository-url>
cd bookstack-mcp-server
bun install
bun run dev          # hot reload; equivalent to: bun --watch src/server.ts
```

```bash
bun run src/server.ts   # start the server
bun test                # run tests
bun run typecheck       # tsc --noEmit
bun run lint            # biome check .
```

> 🔧 See the [Setup Guide](docs/setup-guide.md) for development, Docker, and production deployment

## 🐳 Local testing with Docker Compose

The included `docker-compose.yml` spins up a full local stack — MariaDB, a real
BookStack instance, and this MCP server (built from the Bun `Dockerfile`).

1. **Start the backing services:**

   ```bash
   docker compose up -d db bookstack
   ```

2. **Wait for BookStack** to finish first-boot migrations, then open
   <http://localhost:6875>. Default linuxserver credentials:

   - Email: `admin@admin.com`
   - Password: `password`

3. **Create an API token** in the UI (Edit Profile → **API Tokens** → *Create
   Token*). Combine the Token ID and Token Secret as `token_id:token_secret` and
   put it in a `.env` file next to `docker-compose.yml`, together with an inbound
   secret of your own:

   ```bash
   echo "BOOKSTACK_API_TOKEN=token_id:token_secret" > .env
   echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
   ```

   > The token can only be created after BookStack is running, so it cannot be
   > baked into the image — this manual step is required once.
   >
   > **Both** entries are required. `docker-compose.yml` passes `MCP_AUTH_TOKEN`
   > through to the `mcp` service, and the HTTP transport refuses to start without
   > it, so a `.env` carrying only `BOOKSTACK_API_TOKEN` leaves the container in a
   > restart loop.

4. **Start the MCP server** (it reads both tokens from `.env`):

   ```bash
   docker compose up -d mcp
   ```

5. **Check health** — returns `200` with `{"status":"healthy"}` once the server
   can reach BookStack with your token:

   ```bash
   curl http://localhost:3000/health
   ```

Until a **valid** `BOOKSTACK_API_TOKEN` is supplied the `mcp` container reports
`unhealthy`, because `/health` verifies live connectivity to BookStack. If either token is
**missing entirely** the container does not get that far and restart-loops instead of
answering `503` — check `docker compose logs mcp` for `Configuration validation failed`
(no `BOOKSTACK_API_TOKEN`) or `MCP_AUTH_TOKEN is not set` (no inbound secret).

The compose file pins BookStack to `lscr.io/linuxserver/bookstack:version-v26.05.2` — the
release this repo's tool contract was verified against — and ships a throwaway dev
`APP_KEY`. Generate your own for anything beyond local testing, using the same pinned tag:

```bash
docker run --rm --entrypoint /bin/bash lscr.io/linuxserver/bookstack:version-v26.05.2 appkey
```

It prints one `base64:…` line to paste into `APP_KEY`. The `--entrypoint` override is
required: without it the image runs its normal init first, which halts with
`The application key is missing, halting init!` — the very key you are trying to
generate — and never reaches the `appkey` script.

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🌟 Community

This project is part of the BookStack ecosystem! Check out other API-based tools and scripts in the [BookStack API Scripts](https://codeberg.org/bookstack/api-scripts) repository.

## 🆘 Support

- **📚 Documentation**: Complete guides in the [docs/](docs/) folder
- **🐛 Issues**: [GitHub Issues](https://github.com/pnocera/bookstack-mcp-server/issues)
- **💬 Discussions**: [GitHub Discussions](https://github.com/pnocera/bookstack-mcp-server/discussions)

---

**Built with ❤️ for the BookStack community**
