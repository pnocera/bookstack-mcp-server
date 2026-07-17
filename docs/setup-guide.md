# BookStack MCP Server - Complete Setup & Configuration Guide

## 📋 Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [BookStack Server Requirements](#bookstack-server-requirements)
4. [Installation Methods](#installation-methods)
5. [Configuration](#configuration)
6. [Authentication Setup](#authentication-setup)
7. [Claude Integration](#claude-integration)
8. [Advanced Configuration](#advanced-configuration)
9. [Development Setup](#development-setup)
10. [Deployment Options](#deployment-options)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)

## 🎯 Overview

The BookStack MCP Server provides comprehensive access to BookStack's knowledge management capabilities through the Model Context Protocol (MCP). This guide covers everything you need to set up and configure the server for optimal performance.

### Key Features
- **56 MCP Tools** across 13 categories, covering the supported subset of the BookStack API
- **11 Resources** for dynamic content retrieval
- **Rate Limiting** with configurable limits
- **Comprehensive Validation** using Zod schemas
- **Error Handling** with retry logic
- **TypeScript Support** with complete type definitions

## 🔧 Prerequisites

### System Requirements
- **Bun**: 1.1.0 or higher (Bun runs the TypeScript source directly — there is no build step)
- **Operating System**: Linux, macOS, or Windows
- **Memory**: Minimum 512MB RAM (1GB recommended)
- **Storage**: 100MB for installation + log storage

### Required Services
- **BookStack Instance**: Running and accessible
- **BookStack API**: Enabled with valid token
- **Network Access**: HTTP/HTTPS connection to BookStack

### Verify Prerequisites
```bash
# Check Bun version
bun --version   # Should be 1.1.0+

# Check system resources
free -h         # Linux/macOS
```

## 🏠 BookStack Server Requirements

### BookStack Version
- **Recommended**: Latest stable version of BookStack
- **API Version**: v1 (current)

> ⚠️ **Note**: This server uses modern BookStack API features including the system endpoint for health checks. Please ensure you're running a recent version of BookStack.

### BookStack Configuration
Your BookStack instance must have:

1. **API Access Enabled**
   ```php
   // In BookStack .env file
   API_REQUESTS_PER_MIN=180
   API_DEFAULT_ITEM_COUNT=100
   ```

2. **API Rate Limits** (optional - adjust if needed)
   ```php
   // In BookStack .env file - adjust based on your usage
   API_REQUESTS_PER_MIN=180
   ```

3. **User Permissions**
   - API user must have appropriate permissions
   - Recommended: Admin role for full access
   - Minimum: View permissions for content areas

### API Token Setup

1. **Log into BookStack** as admin or privileged user
2. **Navigate to**: Profile → API Tokens
3. **Create New Token**:
   - Name: `mcp-server-token`
   - Description: `Token for MCP server access`
   - Expiry: Set appropriate expiry (optional)
4. **Combine Token Parts**: BookStack provides a Token ID and Token Secret
   
   **Important**: You need to combine these as `{token_id}:{token_secret}`
   
   Example:
   - Token ID: `AbCdEf123456`
   - Token Secret: `xyz789secretkey`
   - **Final Token**: `AbCdEf123456:xyz789secretkey`

5. **Save Token**: Store the combined token securely for configuration

> 💡 **Token Format**: The API token must be in the format `{token_id}:{token_secret}` as shown in BookStack's API documentation.

## 📦 Installation Methods

> ⚠️ **Bun 1.1.0+ is required, and Node.js is not supported.** This package ships
> TypeScript source rather than a compiled bundle, and its executable begins with
> `#!/usr/bin/env bun`. Bun must be installed on any machine that runs the server —
> `npx` and `npm install -g` cannot run it. Install Bun from <https://bun.sh>.

### Method 1: Run Without Installing (Recommended)
```bash
# Downloads and runs in one step — starts the HTTP server by default
bunx bookstack-mcp-server
```

### Method 2: Global Installation
```bash
# Install globally for system-wide access
bun add -g bookstack-mcp-server

# Run it by name
bookstack-mcp-server
```

### Method 3: Local Project Installation
```bash
# Create project directory
mkdir my-bookstack-mcp
cd my-bookstack-mcp

# Install locally
bun add bookstack-mcp-server

# Or install from source
git clone https://github.com/pnocera/bookstack-mcp-server.git
cd bookstack-mcp-server
bun install
```

### Method 4: Development Installation
```bash
# Clone repository
git clone https://github.com/pnocera/bookstack-mcp-server.git
cd bookstack-mcp-server

# Install dependencies
bun install

# Run development server (hot reload)
bun run dev
```

> 💡 There is no compile step — Bun executes `src/server.ts` directly.

## ⚙️ Configuration

### Environment Variables
Create a `.env` file in your project directory:

```env
# Transport: "http" (default) or "stdio"
MCP_TRANSPORT=http

# Inbound auth for POST /message. REQUIRED when MCP_TRANSPORT=http — the HTTP
# transport refuses to start without it, because /message dispatches every tool
# (including permanent-delete and user/role operations) using the BookStack token
# below. This is NOT the BookStack token; generate a separate secret with:
#   openssl rand -hex 32
# The stdio transport ignores it.
MCP_AUTH_TOKEN=

# BookStack API Configuration
BOOKSTACK_BASE_URL=http://localhost:8080/api
BOOKSTACK_API_TOKEN=your-api-token-here
BOOKSTACK_TIMEOUT=30000

# Server Configuration
SERVER_NAME=bookstack-mcp-server
# SERVER_VERSION is deliberately unset: it defaults to this package's real
# version from package.json. Setting it here would pin a literal that no
# release updates, so the server would keep announcing a stale version.
# Override only if you intentionally want to report something else.
# SERVER_VERSION=
SERVER_PORT=3000

# Rate Limiting
RATE_LIMIT_REQUESTS_PER_MINUTE=60
RATE_LIMIT_BURST_LIMIT=10

# Validation
VALIDATION_ENABLED=true
VALIDATION_STRICT_MODE=true

# Logging
LOG_LEVEL=info
LOG_FORMAT=pretty

# Development
NODE_ENV=development
DEBUG=false
```

> 💡 These are the variables the server actually reads. The full, authoritative
> list is the Zod schema in `src/config/manager.ts` — anything documented beyond
> it does not exist.

### Configuration Options Explained

#### Transport
- **MCP_TRANSPORT**: Which transport the server starts
  - Default: `http` — starts the Streamable HTTP server on `SERVER_PORT`
  - Only the exact value `stdio` selects stdio; any other value falls back to HTTP
  - Stdio is required for Claude Desktop; HTTP is what n8n and other remote clients use

#### BookStack Settings
- **BOOKSTACK_BASE_URL**: Full URL to BookStack API endpoint
  - Format: `http://yourserver.com/api`
  - Include `/api` suffix
  - Use HTTPS in production

- **BOOKSTACK_API_TOKEN**: API token from BookStack
  - Generate in BookStack admin panel
  - Keep secure and rotate regularly

- **BOOKSTACK_TIMEOUT**: Request timeout in milliseconds
  - Default: 30000 (30 seconds)
  - Increase for slow networks

#### Rate Limiting
- **RATE_LIMIT_REQUESTS_PER_MINUTE**: Maximum requests per minute
  - Default: 60
  - Adjust based on BookStack limits

- **RATE_LIMIT_BURST_LIMIT**: Token-bucket burst capacity
  - Default: 10
  - How many requests may start *immediately* when the bucket is full, before callers
    have to wait for it to refill at RATE_LIMIT_REQUESTS_PER_MINUTE
  - Not a concurrency limit: it does not count or cap requests already in flight
  - Prevents a burst from overwhelming BookStack

#### Logging
- **LOG_LEVEL**: Logging verbosity
  - Options: `error`, `warn`, `info`, `debug`
  - Use `info` for production

- **LOG_FORMAT**: Log output format
  - Options: `json`, `pretty`
  - Use `json` for production logs

#### Validation
- **VALIDATION_ENABLED**: Enable input validation
  - Default: `true`
  - Always keep enabled

- **VALIDATION_STRICT_MODE**: Strict validation mode
  - Default: `true`
  - Invalid tool params are rejected at the boundary with a clear error. Set to
    `false` to instead log a warning and forward them to BookStack, which will
    usually reject them with a `422`.

## 🔐 Authentication Setup

### BookStack User Setup
1. **Create Service Account** (recommended)
   ```
   Email: mcp-service@yourcompany.com
   Name: MCP Service Account
   Role: Admin (or custom role with required permissions)
   ```

2. **Generate API Token**
   - Login as service account
   - Go to Profile → API Tokens
   - Create token with descriptive name
   - **Important**: Combine the Token ID and Token Secret as `{token_id}:{token_secret}`
   - Store the combined token securely

### Token Security
- **Storage**: Use environment variables or secure vault
- **Rotation**: Implement regular token rotation
- **Monitoring**: Monitor token usage and access

### Permission Requirements
The API user needs these minimum permissions:
- **Books**: View, Create, Update, Delete
- **Pages**: View, Create, Update, Delete
- **Chapters**: View, Create, Update, Delete
- **Shelves**: View, Create, Update, Delete
- **Users**: View (for user management tools)
- **System**: View (for system info tools)

## 🎨 Claude Integration

### Claude Desktop Integration
Add to your Claude Desktop configuration:

> ⚠️ Claude Desktop speaks MCP over **stdio**, but this server starts in HTTP
> mode by default. Every configuration below must set `MCP_TRANSPORT=stdio`, or
> Claude will fail to connect.

#### Method 1: Manual Configuration
Edit `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "bookstack": {
      "command": "bunx",
      "args": ["bookstack-mcp-server"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "BOOKSTACK_BASE_URL": "http://localhost:8080/api",
        "BOOKSTACK_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

> If you installed globally with `bun add -g`, you can use
> `"command": "bookstack-mcp-server"` and drop `"args"`. Either way Bun must be
> on the `PATH` that Claude Desktop launches with.

#### Method 2: Using Claude CLI
```bash
# Add server configuration
claude mcp add bookstack bunx bookstack-mcp-server \
  --env MCP_TRANSPORT=stdio \
  --env BOOKSTACK_BASE_URL=http://localhost:8080/api \
  --env BOOKSTACK_API_TOKEN=your-api-token-here

# Verify configuration
claude mcp list
```

### Claude Code Integration
For Claude Code MCP support:

```bash
# Add as MCP server
claude mcp add-json bookstack '{
  "type": "stdio",
  "command": "bunx",
  "args": ["bookstack-mcp-server"],
  "env": {
    "MCP_TRANSPORT": "stdio",
    "BOOKSTACK_BASE_URL": "http://localhost:8080/api",
    "BOOKSTACK_API_TOKEN": "your-api-token-here"
  }
}'
```

### Configuration File Locations
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

## 🔧 Advanced Configuration

The server is configured **entirely through environment variables** (loaded from
the process environment or a `.env` file via `dotenv`). There is no configuration
file format — see [Configuration](#configuration) for the full set of supported
variables, and `src/config/manager.ts` for the schema that defines them.

### Production Configuration
For production deployments:

```env
# Production Environment Variables
NODE_ENV=production
DEBUG=false
LOG_LEVEL=warn
LOG_FORMAT=json

# Performance
RATE_LIMIT_REQUESTS_PER_MINUTE=180
RATE_LIMIT_BURST_LIMIT=30
```

### Multiple BookStack Instances
A single server process talks to exactly one BookStack instance. To cover
several, run one server per instance with its own `BOOKSTACK_BASE_URL`,
`BOOKSTACK_API_TOKEN`, and `SERVER_PORT`.

Alternatively, in HTTP mode a single server can serve multiple instances by
sending per-request credentials on `POST /message` with the `x-bookstack-url`
and `x-bookstack-token` headers, which override the environment defaults.

## 🛠️ Development Setup

### Development Environment
```bash
# Clone repository
git clone https://github.com/pnocera/bookstack-mcp-server.git
cd bookstack-mcp-server

# Install dependencies
bun install

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env

# Start development server
bun run dev
```

### Development Scripts
```bash
# Development server with hot reload
bun run dev

# Start the server
bun run src/server.ts

# Type-check (no emit)
bun run typecheck

# Run tests
bun test

# Run tests with coverage
bun test --coverage

# Lint code
bun run lint

# Format code
bun run format
```

### Testing Configuration
```bash
# Run specific test file
bun test books.test.ts

# Run tests in watch mode
bun test --watch
```

## 🚀 Deployment Options

### Systemd Service (Linux)
Create `/etc/systemd/system/bookstack-mcp.service`:

```ini
[Unit]
Description=BookStack MCP Server
After=network.target

[Service]
Type=simple
User=bookstack-mcp
WorkingDirectory=/opt/bookstack-mcp
ExecStart=/usr/local/bin/bun run /opt/bookstack-mcp/src/server.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/bookstack-mcp/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable bookstack-mcp
sudo systemctl start bookstack-mcp
sudo systemctl status bookstack-mcp
```

### Docker Deployment

The repository ships a Bun-based `Dockerfile` — no need to write your own. It
installs production dependencies, copies the TypeScript source (no build step),
runs as the non-root `bun` user, and declares a `HEALTHCHECK` against
`GET /health`.

Build and run in **HTTP mode** (the default):
```bash
# Build image
docker build -t bookstack-mcp-server .

# Generate the inbound secret callers will present to POST /message.
# Required: the HTTP transport refuses to start without it, so a container
# missing it restart-loops instead of listening.
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"

# Run container
docker run -d \
  --name bookstack-mcp \
  -p 3000:3000 \
  -e BOOKSTACK_BASE_URL=http://bookstack:8080/api \
  -e BOOKSTACK_API_TOKEN=token_id:token_secret \
  -e MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
  bookstack-mcp-server

# Verify — the MCP endpoint is POST /message; GET / and GET /health are probes
curl http://localhost:3000/health
```

Prefer keeping secrets out of your shell history and `docker inspect`? Put the same
variables in a file and pass `--env-file` instead:

```bash
cp .env.example .env
# Then fill in BOOKSTACK_API_TOKEN and MCP_AUTH_TOKEN, and point BOOKSTACK_BASE_URL at
# BookStack *as the container sees it* — the shipped http://localhost:8080/api resolves
# to the MCP container itself, not to your BookStack host.
docker run -d --name bookstack-mcp -p 3000:3000 --env-file .env bookstack-mcp-server
```

The bundled scripts do exactly this — `bun run docker:build` builds the image above, and
`bun run docker:run` is the `--env-file .env` form, run in the foreground with `--rm`:

```bash
bun run docker:build
bun run docker:run     # docker run --rm -p 3000:3000 --env-file .env bookstack-mcp-server
```

So `.env` must carry `BOOKSTACK_API_TOKEN` and `MCP_AUTH_TOKEN` before `docker:run` will
start; without the latter the container prints `MCP_AUTH_TOKEN is not set` and exits.

#### Running stdio in Docker

Stdio mode reads MCP requests from **stdin**. Without `-i`, `docker run` gives
the container no stdin, so stdin hits EOF and the process exits immediately —
the container appears to start and die instantly. Pass `-i`:

```bash
docker run -i --rm \
  -e MCP_TRANSPORT=stdio \
  -e BOOKSTACK_BASE_URL=http://bookstack:8080/api \
  -e BOOKSTACK_API_TOKEN=token_id:token_secret \
  bookstack-mcp-server
```

Use `-i`, not `-it` — allocating a TTY corrupts the JSON-RPC stream that MCP
clients pipe over stdin/stdout. No port mapping is needed in stdio mode.

> ⚠️ The image's `HEALTHCHECK` probes `http://localhost:3000/health`, so a
> container started with `MCP_TRANSPORT=stdio` will report `unhealthy` — nothing
> is listening on a port in stdio mode. That is expected.


## 🔍 Troubleshooting

### Common Issues

#### 1. "Listening on port 3000" but no endpoint responds
**Symptom**: The server logs `BookStack MCP Server listening on port 3000`, but requests 404.

**Cause**: The MCP endpoint is `POST /message`. Browsing to a path that isn't
`/`, `/health`, or `/message` returns a JSON `404` that lists the valid
endpoints. A browser can only issue `GET`, so it can never reach `POST /message`.

**Solutions**:
- Confirm the server is up: `curl http://localhost:3000/` → `{"status":"running", ...}`
- Confirm BookStack connectivity: `curl -i http://localhost:3000/health`
- Send MCP traffic to `POST /message` (see [HTTP Endpoints](#http-endpoints))
- For n8n and other remote MCP clients, use `http://<host>:3000/message`

#### 2. Container with `MCP_TRANSPORT=stdio` starts then exits immediately
**Symptom**: `docker run -e MCP_TRANSPORT=stdio ...` dies right after starting.

**Cause**: Stdio mode reads MCP requests from stdin. Without `-i`, the container
has no stdin, so stdin hits EOF and the process exits.

**Solution**: Add `-i` (and not `-t`) — see [Running stdio in Docker](#running-stdio-in-docker).

#### 3. Connection Refused
**Error**: `ECONNREFUSED` connecting to BookStack

**Solutions**:
- Verify BookStack is running and accessible
- Check `BOOKSTACK_BASE_URL` is correct
- Ensure `/api` suffix is included in URL
- Test API access: `curl -H "Authorization: Token YOUR_TOKEN" http://localhost:8080/api/docs`

#### 4. Authentication Failed
**Error**: `401 Unauthorized` or `403 Forbidden`

**Solutions**:
- Verify API token is correct and not expired
- Check user permissions in BookStack
- Ensure token has required scopes
- Test token: `curl -H "Authorization: Token YOUR_TOKEN" http://localhost:8080/api/users`

#### 5. Rate Limit Exceeded
**Error**: `429 Too Many Requests`

**Solutions**:
- Reduce `RATE_LIMIT_REQUESTS_PER_MINUTE`
- Increase `RATE_LIMIT_BURST_LIMIT`
- Check BookStack rate limits
- Implement request queuing

#### 6. Validation Errors
**Error**: `Configuration validation failed`

**Solutions**:
- Check all required environment variables are set
- Verify URL format (must include protocol)
- Ensure numeric values are valid
- Review configuration schema

#### 7. Memory Issues
**Error**: `JavaScript heap out of memory`

**Solutions**:
- Reduce concurrent connections
- Lower `RATE_LIMIT_BURST_LIMIT`
- Check for memory leaks

### Debug Mode
Enable debug logging:

```bash
# Set debug environment
export DEBUG=true
export LOG_LEVEL=debug

# Run with debug output
bun run dev
```

### HTTP Endpoints

In HTTP mode the server exposes exactly three endpoints. Any other path returns
a JSON `404` listing the valid ones.

| Method & path | Purpose | Status codes |
| --- | --- | --- |
| `GET /` | Server info JSON (name, version, `status: "running"`, endpoint list) | `200` |
| `GET /health` | Health check — verifies live connectivity to BookStack | `200` healthy, `503` unhealthy |
| `POST /message` | **The MCP endpoint** — send JSON-RPC MCP messages here | `200`, `401` without a valid bearer token, `500` on error |

`GET /` and `GET /health` are unauthenticated probes. **`POST /message` requires an
inbound `Authorization: Bearer <secret>` header**, since it dispatches every tool —
the HTTP transport refuses to start until a secret is configured, and its startup
error names the exact variable to set.

`POST /message` also accepts per-request credential overrides via the
`x-bookstack-url` and `x-bookstack-token` headers, falling back to
`BOOKSTACK_BASE_URL` / `BOOKSTACK_API_TOKEN`.

```bash
# MCP initialize handshake — Content-Type and Accept are required by the
# transport; Authorization carries this server's inbound secret, i.e. the same
# MCP_AUTH_TOKEN value the server was started with.
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

### Health Checks
Monitor server health:

```bash
# Check server status — 200 when healthy, 503 when BookStack is unreachable
curl -i http://localhost:3000/health

# Expected response
{
  "status": "healthy",
  "checks": [
    {"name": "bookstack_connection", "healthy": true, "message": "BookStack API connection"},
    {"name": "tools_loaded", "healthy": true, "message": "56 tools loaded"},
    {"name": "resources_loaded", "healthy": true, "message": "11 resources loaded"}
  ]
}
```

A `503` with `"status": "unhealthy"` means the server itself is running but a
check failed — most often `bookstack_connection`, caused by an **invalid**
`BOOKSTACK_API_TOKEN` (present but wrong or revoked) or an unreachable
`BOOKSTACK_BASE_URL`.

A **missing** `BOOKSTACK_API_TOKEN` never produces a `503`. The token is validated
at startup (`z.string().min(1)`), so an empty value fails config validation before
Express binds the port:

```
error: Configuration validation failed: bookstack.apiToken: BookStack API token is required - set BOOKSTACK_API_TOKEN environment variable
```

The process exits, nothing listens on `SERVER_PORT`, and `curl` gets a connection
refused rather than a status code. Distinguishing the two saves time: **`503` = bad
token, connection refused = no token.**

### Log Analysis

The server writes logs to **stderr** only — it never writes a log file. Read them
from whatever supervises the process, or redirect stderr yourself:

```bash
# systemd
journalctl -u bookstack-mcp -f
journalctl -u bookstack-mcp | grep -i error

# Docker
docker logs -f bookstack-mcp

# Redirect to a file yourself, if you want one on disk
bun run src/server.ts 2> /var/log/bookstack-mcp.log
```

Set `LOG_FORMAT=json` for machine-parseable output and `LOG_LEVEL=debug` for
maximum verbosity.

### Performance Monitoring
Monitor performance metrics:

```bash
# Check memory usage
ps aux | grep bookstack-mcp

# Monitor network connections
netstat -an | grep :3000

# Check file descriptors
lsof -p $(pgrep -f bookstack-mcp)
```

## ❓ FAQ

### Q: Can I use this with BookStack SaaS?
A: Yes, if your BookStack SaaS provider supports API access. Contact your provider for API endpoint and token generation.

### Q: Does this support multiple BookStack instances?
A: Currently, one instance per server. For multiple instances, run multiple MCP servers with different configurations.

### Q: What's the difference between tools and resources?
A: **Tools** are active functions (create, update, delete). **Resources** are passive data access (read-only content).

### Q: How do I backup my configuration?
A: Back up your `.env` file — it is the only configuration. Store API tokens securely.

### Q: Can I customize the available tools?
A: Only by modifying the source code. There is no feature-flag or tool-toggle configuration.

### Q: How do I migrate from an older version?
A: 
1. Backup current configuration
2. Update to new version
3. Compare configuration schemas
4. Test all integrations
5. Update Claude integration if needed

### Q: Is there a GUI for configuration?
A: Currently no GUI is available. Configuration is done entirely through environment variables.

### Q: How do I contribute to the project?
A: 
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

### Q: What's the performance impact?
A: Minimal. The server uses HTTP connection pooling toward BookStack. Typical memory usage is 50-100MB.

### Q: Can I use this in production?
A: Yes, it's designed for production use. Follow the production configuration guidelines and implement proper monitoring.

---

## 📞 Support

- **Documentation**: [GitHub Repository](https://github.com/pnocera/bookstack-mcp-server)
- **Issues**: [GitHub Issues](https://github.com/pnocera/bookstack-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/pnocera/bookstack-mcp-server/discussions)

## 📝 License

This project is licensed under the MIT License. See the [LICENSE](../LICENSE) file for details.

---

**Built with ❤️ for the BookStack community**
