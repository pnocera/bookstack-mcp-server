# Server Instructions (`initialize` response)

## Overview

The MCP protocol allows a server to return a server-wide hint text in the `instructions`
field of the JSON-RPC `initialize` response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "serverInfo": { "name": "bookstack-mcp-server", "version": "1.0.0" },
    "capabilities": { ... },
    "instructions": "Your hint text here"
  }
}
```

MCP clients (e.g. Claude Desktop, Claude.ai) typically pass this text to the AI assistant as
additional system context, helping it understand what the server provides and how to use its
tools effectively.

## Configuration

Set the `SERVER_INSTRUCTIONS` environment variable to define the instructions text:

```env
SERVER_INSTRUCTIONS=This server provides access to our internal BookStack knowledge base. \
  Always use bookstack_search first to find relevant content before reading individual pages.
```

**Behaviour:**

| Variable state       | `instructions` field in response |
|----------------------|----------------------------------|
| Set to a non-empty string | Included with the given text |
| Empty string (`""`)  | **Omitted** (field not sent)     |
| Not set              | **Omitted** (field not sent)     |

An empty or missing `SERVER_INSTRUCTIONS` is the safe default — the response is fully valid
without the field.

## Multi-line text

Environment variables do not natively support line breaks in most `.env` files. Options:

- Use `\n` as a literal escape (some clients interpret it):
  ```env
  SERVER_INSTRUCTIONS=Line one.\nLine two.\nLine three.
  ```
- Use a `docker-compose.yml` environment block with YAML multi-line syntax:
  ```yaml
  environment:
    SERVER_INSTRUCTIONS: |
      This server provides access to the BookStack knowledge base.
      Use bookstack_search to find relevant pages.
      Then use bookstack_pages_read to read full page content.
  ```

## Debugging

Set `DEBUG=true` alongside `SERVER_INSTRUCTIONS` to confirm the value was received at
container startup:

```
[mcp] SERVER_INSTRUCTIONS set (87 chars):
This server provides access to the BookStack knowledge base. Use bookstack_search first.
```

If the variable is not set:
```
[mcp] SERVER_INSTRUCTIONS not set — initialize response omits "instructions"
```

The SDK-level debug log (emitted per child process on `LOG_LEVEL=debug`) confirms the value
was passed through to the MCP `Server` instance:
```
debug: Server instructions { set: true, length: 87 }
```

## Verifying the response

Send a raw `initialize` request to confirm the field appears in the response.
Replace the authorization header with a valid Bearer token from your OAuth flow:

```bash
curl -s -X POST https://mcp-bookstack.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "test", "version": "0" }
    }
  }'
```

Expected output (with `SERVER_INSTRUCTIONS` set):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "serverInfo": { ... },
    "capabilities": { ... },
    "instructions": "Your hint text here"
  }
}
```

## Implementation notes

- The `@modelcontextprotocol/sdk` `Server` class natively supports the `instructions` option
  in its constructor — no SDK patching required.
- In HTTP mode the proxy (`http-server.js`) spawns a child process per session. The child
  receives `SERVER_INSTRUCTIONS` explicitly via the `spawnChild` environment allowlist.
- The instructions text is set once at server startup and is the same for every session.
