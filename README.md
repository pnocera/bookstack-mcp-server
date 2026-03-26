# BookStack MCP Server (Read-Only)

Connect BookStack to Claude and other AI assistants through the Model Context Protocol (MCP).

By default this server runs in **public read-only mode**: only 18 read/search/export tools are exposed, write operations are blocked, and per-request credential headers are rejected. It is safe to deploy publicly without authentication middleware.

## Transport modes

- **Streamable HTTP** (default) — stateless, one MCP connection per request, port 3000
- **Stdio** — for local use with Claude Desktop; set `MCP_TRANSPORT=stdio`

## Read-only mode (default)

When `PUBLIC_READ_ONLY=true` (the default):

- Only read, search, and export tools are registered — no create/update/delete.
- `UserResources`, `RoleTools`, `AttachmentTools`, `ImageTools`, `RecycleBinTools`, `PermissionTools`, `AuditTools` are not loaded.
- `x-bookstack-url` and `x-bookstack-token` request headers are **rejected with HTTP 400**.
- Even if a blocked tool name is sent directly, the server returns: `Tool disabled on this public read-only server: <name>`.

To enable full CRUD mode set `PUBLIC_READ_ONLY=false`. To allow per-request credential overrides set `ALLOW_BOOKSTACK_HEADER_OVERRIDES=true`.

### Available tools in read-only mode (18 total)

| Category | Tools |
|----------|-------|
| Books | `bookstack_books_list`, `bookstack_books_read`, `bookstack_books_export` |
| Pages | `bookstack_pages_list`, `bookstack_pages_read`, `bookstack_pages_export` |
| Chapters | `bookstack_chapters_list`, `bookstack_chapters_read`, `bookstack_chapters_export` |
| Shelves | `bookstack_shelves_list`, `bookstack_shelves_read` |
| Search | `bookstack_search` |
| System | `bookstack_system_info` |
| Meta | `bookstack_server_info`, `bookstack_tool_categories`, `bookstack_usage_examples`, `bookstack_error_guides`, `bookstack_help` |

## Configuration

Required environment variables:

```bash
BOOKSTACK_BASE_URL=https://your-bookstack.example.com/api
BOOKSTACK_API_TOKEN=token_id:token_secret
```

Key optional variables (all have safe defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_READ_ONLY` | `true` | Restrict to read-only tools |
| `ALLOW_BOOKSTACK_HEADER_OVERRIDES` | `false` | Allow per-request credential headers |
| `PORT` | `3000` | HTTP listen port |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | `pretty` | `json` or `pretty` |

See `.env.example` for the full list.

## Docker deployment

```bash
# 1. Configure credentials
cp .env.example .env
# Edit .env — set BOOKSTACK_BASE_URL and BOOKSTACK_API_TOKEN

# 2. Build and start
docker compose up -d

# 3. Verify
curl http://localhost:3000/healthz
# → {"ok":true}
```

### Verification checklist

```bash
# Health endpoint
curl http://localhost:3000/healthz

# Header override must be rejected with 400
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -H "x-bookstack-url: https://evil.example.com" \
  -d '{}'
# → 400

# Use your MCP client to list tools — only read-only names should appear
# Use your MCP client to call bookstack_books_create
# → "Tool disabled on this public read-only server: bookstack_books_create"
```

## Local development

```bash
npm install
cp .env.example .env   # set BOOKSTACK_BASE_URL and BOOKSTACK_API_TOKEN
npm run dev            # ts-node single run
npm run watch          # auto-restart on file changes
npm run build          # compile to dist/
npm test               # Jest
```

### Add to Claude Code (stdio mode)

```bash
claude mcp add bookstack npx bookstack-mcp-server \
  --env BOOKSTACK_BASE_URL=https://your-bookstack.example.com/api \
  --env BOOKSTACK_API_TOKEN=token_id:token_secret \
  --env MCP_TRANSPORT=stdio
```

## Documentation

- [Setup Guide](docs/setup-guide.md)
- [Tools Overview](docs/tools-overview.md)
- [Resources Guide](docs/resources-guide.md)
- [Examples & Workflows](docs/examples-and-workflows.md)

## License

MIT — see [LICENSE](LICENSE).
