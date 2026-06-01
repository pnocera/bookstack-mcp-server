# bookstack-mcp-docker

A self-contained Docker image that exposes your [BookStack](https://www.bookstackapp.com/) knowledge base to Claude.ai as a **Custom Connector** via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

> **Forked from** [pnocera/bookstack-mcp-server](https://github.com/pnocera/bookstack-mcp-server) — the original TypeScript stdio MCP server with 47+ BookStack tools.
> This fork adds a **Dockerized HTTP/OAuth gateway** on top, making it usable as a remote MCP connector for Claude.ai without any additional bridge service.

The HTTP gateway wraps the stdio MCP server with:
- **OAuth 2.0 Authorization Code + PKCE** (required by Claude.ai)
- **Per-user BookStack token** — each user authenticates with their own API token
- **Streamable HTTP transport** (MCP protocol over HTTPS)
- **JWT access tokens** (1 h) + refresh tokens (30 d)
- **Dynamic Client Registration** (Claude registers itself automatically)
- **Transparent session recovery** — lost sessions are rebuilt without re-authentication

## What You Get

- **47+ MCP Tools** — full CRUD for books, pages, chapters, shelves, users, roles, permissions, attachments, images, search, audit log, recycle bin, and system info
- **Two transport modes** — HTTP/OAuth (Claude.ai Custom Connector) and stdio (Claude Desktop / Claude Code)
- **Single Docker image** — no separate bridge service required
- **Upstream-syncable** — fork tracks `pnocera/bookstack-mcp-server` via git remote `upstream`

## Architecture

```
Claude.ai  ──HTTPS──▶  nginx (TLS termination)
                            │
                            ▼
               bookstack-mcp container (:3100)
               ┌──────────────────────────────────┐
               │  src/http-server.js               │
               │  ├── /.well-known/oauth-*         │  OAuth metadata
               │  ├── /oauth/register              │  Dynamic Client Registration
               │  ├── /oauth/authorize             │  Consent page + token validation
               │  ├── /oauth/token                 │  JWT issuance (PKCE S256)
               │  └── /mcp                         │  Streamable HTTP
               │        │                          │
               │        ▼  child_process (stdio)   │
               │  dist/server.js (compiled TS)     │
               └──────────────────────────────────┘
                            │
                            ▼ (internal Docker network)
               BookStack container (:80)
```

## Auth Flow

```
1. Claude.ai opens the OAuth consent page
2. User enters their BookStack API token (token_id:token_secret)
3. Server validates token live: GET /api/books against BookStack
4. Valid → authorization code issued, redirect back to Claude
5. Claude exchanges code for JWT (PKCE S256 verified)
6. BookStack token is stored in the JWT payload (bst claim, signed HS256)
7. Each MCP request: token extracted from JWT → passed to child process
```

No central user management needed — BookStack is both the auth source and the resource.

## Prerequisites

- Docker + Docker Compose (or Portainer)
- A running [BookStack](https://www.bookstackapp.com/) instance
- A public domain with HTTPS (e.g. via Let's Encrypt + nginx)

Each user needs their own BookStack API token: **Settings → API Tokens → Add Token**

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOOKSTACK_BASE_URL` | ✓ | Internal BookStack API URL, e.g. `http://bookstack:80/api` |
| `JWT_SECRET` | ✓ | Random secret — generate with `openssl rand -base64 32` |
| `BASE_URL` | ✓ | Public HTTPS URL of this MCP server |
| `MCP_PORT` | | Port inside the container (default: `3100`) |
| `DEBUG` | | Set to `true` to enable auth debug logging |
| `VERBOSE` | | Set to `1`, `true`, `True`, or `TRUE` to log full request and response JSON on stderr |

### 2. Add to your docker-compose.yml

Copy the contents of [`docker-compose.snippet.yml`](docker-compose.snippet.yml) into your existing `docker-compose.yml` (the one that also runs BookStack).

If `bookstack-mcp` runs in the same compose file as `bookstack`, set:
```env
BOOKSTACK_BASE_URL=http://bookstack:80/api
```
This routes traffic directly through the internal Docker network — no TLS overhead, no external roundtrip.

### 3. Configure nginx

Add a new vhost using [`nginx.snippet.conf`](nginx.snippet.conf) as a template and obtain an SSL certificate:

```bash
certbot --nginx -d mcp-bookstack.example.com
```

### 4. Start the service

```bash
docker compose up -d bookstack-mcp
```

### 5. Verify

```bash
curl https://mcp-bookstack.example.com/.well-known/oauth-authorization-server
docker logs bookstack-mcp -f
```

## Connect Claude.ai

1. Open Claude.ai → **Settings** → **Integrations** → **Add custom connector**
2. Set **MCP Server URL** to `https://mcp-bookstack.example.com/mcp`
3. Set **Authentication** to **OAuth**
4. Click **Connect** — a browser window opens with the consent page
5. Enter your BookStack API token (`token_id:token_secret`)
6. Click **Allow Access**
7. Test: ask Claude *"List all BookStack books"*

![Claude Desktop — connecting to BookStack MCP](docs/assets/claude-desktop-connect.png)

Claude registers itself automatically via Dynamic Client Registration — no manual client setup required.

## Stdio Mode (Claude Desktop / Claude Code)

The original stdio transport is also available:

```bash
# Direct (after npm install && npm run build)
BOOKSTACK_BASE_URL=https://your-bookstack.com/api \
BOOKSTACK_API_TOKEN=token_id:token_secret \
node dist/server.js

# Via Docker
docker run --rm \
  -e BOOKSTACK_BASE_URL=https://your-bookstack.com/api \
  -e BOOKSTACK_API_TOKEN=token_id:token_secret \
  volkerhaensel/bookstack-mcp-docker:latest \
  node dist/server.js

# Claude Code
claude mcp add bookstack npx bookstack-mcp-server \
  --env BOOKSTACK_BASE_URL=https://your-bookstack.com/api \
  --env BOOKSTACK_API_TOKEN=token_id:token_secret \
  --env MCP_TRANSPORT=stdio
```

## Available Tools

**47+ tools across 13 categories:**

| Category | Tools |
|----------|-------|
| 📚 Books | Create, read, update, delete, export |
| 📄 Pages | Manage pages with HTML/Markdown content |
| 📑 Chapters | Organize pages within books |
| 📚 Shelves | Group books into collections |
| 👥 Users & Roles | Complete user management |
| 🔍 Search | Advanced search across all content |
| 🖼️ Images | Flexible upload (base64, data URI, URL, portal) |
| 📎 Attachments | File management |
| 🔐 Permissions | Content access control |
| 🗑️ Recycle Bin | Deleted item recovery |
| 📊 Audit Log | Activity tracking |
| ⚙️ System Info | Instance health and information |

See the upstream [Tools Overview](docs/tools-overview.md) for full documentation.

## Image Upload

Images can be uploaded to the BookStack gallery via three input formats and an optional browser portal for large files.

### Input formats for `bookstack_images_create` / `bookstack_images_update`

| Format | Example |
|--------|---------|
| Plain base64 | `iVBORw0KGgoAAAANSUhEUg...` |
| Data URI | `data:image/png;base64,iVBORw0KGgo...` |
| HTTP/HTTPS URL | `https://example.com/photo.jpg` (fetched server-side) |

Supported MIME types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/bmp`, `image/tiff`, `image/svg+xml`  
Maximum size: 50 MB

URL fetching includes **SSRF protection** — loopback, private, link-local, and multicast IPs are rejected; redirects are validated hop-by-hop.

### Browser upload portal

For images that are too large to pass as inline base64 (typically > 100 KB), the gateway provides a browser-based upload portal:

```
GET /upload
```

**Features:**
- Drag & drop an image onto the drop zone
- Paste with **Ctrl+V** anywhere on the page
- Click to browse from the file system
- Preview before uploading
- Returns a temporary URL valid for **10 minutes**
- Copy-to-clipboard button for the URL

**Workflow:**

```
1. Open  https://mcp-bookstack.example.com/upload  in a browser
2. Drag & drop or paste the image
3. Click "Upload Image" — a URL is displayed
4. Pass the URL to Claude, who uses it in bookstack_images_create
```

Claude can also retrieve the portal URL itself via the MCP tool `bookstack_images_get_upload_url`.  
When an image is too large, Claude will proactively suggest the portal.

### Upload portal endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/upload` | Browser upload portal (no auth required) |
| `POST` | `/staging/upload` | Receive raw image binary, return temporary URL |
| `GET` | `/staging/:id` | Serve staged image (expires after 10 min) |

Staged images are stored **in memory only** — they are not written to disk and are automatically cleaned up after expiry.

## OAuth Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST` | `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| `GET` | `/oauth/authorize` | HTML consent page |
| `POST` | `/oauth/authorize` | Validates BookStack token, issues authorization code |
| `POST` | `/oauth/token` | Code → JWT exchange (PKCE S256) |
| `ALL` | `/mcp` | Authenticated MCP endpoint |

## Token Lifetime

| Token | Lifetime |
|-------|----------|
| Access token | 1 hour |
| Refresh token | 30 days |

Claude refreshes tokens automatically — no manual re-authorization needed until the refresh token expires.

## Docker Hub

```bash
docker pull volkerhaensel/bookstack-mcp-docker:latest
```

## Building Locally

```bash
git clone https://github.com/volker76/bookstack-mcp-docker.git
cd bookstack-mcp-docker
npm install
npm run build        # compile TypeScript
npm run start:http   # start HTTP/OAuth gateway (port 3100)
# or
npm start            # start stdio server
```

Docker:
```bash
docker build -t volkerhaensel/bookstack-mcp-docker:latest .
```

## Syncing with Upstream

```bash
git fetch upstream
git merge upstream/main
npm run build
docker build -t volkerhaensel/bookstack-mcp-docker:latest . && \
  docker push volkerhaensel/bookstack-mcp-docker:latest
```

## Security Notes

- **Never commit `.env`** — it is listed in `.gitignore`
- **JWT_SECRET** must be set explicitly in production; a random key is generated on startup if not set, invalidating all tokens on restart
- **BookStack token in JWT** — the token is stored in the signed JWT payload (`bst` claim). The payload is base64-encoded but not encrypted (signed HS256). Acceptable because transport is HTTPS-only and the BookStack token is a dedicated API credential, not a master password
- **Port binding** — bind to `127.0.0.1:3100:3100` in production so the port is only reachable via nginx, not directly from the internet

## Server Instructions

The `SERVER_INSTRUCTIONS` environment variable lets you set a server-wide hint text that MCP
clients receive in the `result.instructions` field of the JSON-RPC `initialize` response.
Use it to tell the AI assistant what this server is for, what content is available, and how
to use the tools effectively.

```env
SERVER_INSTRUCTIONS=This server gives access to our internal BookStack knowledge base. \
  Use bookstack_search to find relevant pages before reading them individually.
```

If the variable is empty or unset, the `instructions` field is **omitted entirely** from the
response — no empty string is sent.

See [docs/instructions.md](docs/instructions.md) for full details and examples.

## Debugging

Set `DEBUG=true` in the environment to enable auth debug output:

```bash
docker logs bookstack-mcp -f
```

### Verbose request/response logging

Set `VERBOSE=1` (or `true` / `True` / `TRUE`) to have the MCP server core log every
incoming request and the full JSON response on **stderr**:

```bash
# standalone / stdio
VERBOSE=1 MCP_TRANSPORT=stdio node dist/server.js

# docker-compose
environment:
  - VERBOSE=1
```

When active, the server forces its log level to `debug` (overrides `LOG_LEVEL`) and emits
`[VERBOSE]` prefixed lines for:
- Every tool call with its arguments (`CallTool request`)
- The complete result JSON before it is wrapped in the MCP envelope (`CallTool response`)
- `ListTools`, `ListResources`, and `ReadResource` requests and responses

This is intended for development and troubleshooting only — leave it off in production
to keep logs concise.

## License

MIT — see [LICENSE](LICENSE) for details.

---

Upstream project: [pnocera/bookstack-mcp-server](https://github.com/pnocera/bookstack-mcp-server)
