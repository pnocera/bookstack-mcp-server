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
```

## Architecture

This is a TypeScript **Model Context Protocol (MCP) server** that bridges the BookStack knowledge management system with AI assistants. It provides 47+ tools for CRUD operations on BookStack content.

### Transport Modes
Two MCP transport modes are supported (configured at startup):
- **HTTP** (default): Streamable HTTP for remote connections
- **Stdio**: For local use with Claude Desktop

### Key Source Directories

- **`src/server.ts`** — Entry point; `BookStackMCPServer` class that registers all tools and resources, handles both transport modes
- **`src/api/client.ts`** — Axios-based wrapper around the BookStack REST API; integrates rate limiting; all API calls go through here
- **`src/config/manager.ts`** — Singleton `ConfigManager` using Zod for environment variable validation
- **`src/tools/`** — 14 files, each exporting 3–6 MCP tools (books, pages, chapters, shelves, users, roles, attachments, images, search, permissions, audit, recyclebin, system, server-info)
- **`src/resources/`** — 6 files defining dynamic URI-based MCP resources (e.g., `bookstack://books/{id}`)
- **`src/validation/validator.ts`** — 25+ Zod schemas for all tool inputs; strict mode optionally fails on validation errors
- **`src/utils/`** — `logger.ts` (Winston singleton), `errors.ts` (HTTP status → MCP error code mapping), `rateLimit.ts` (token bucket algorithm)
- **`src/types.ts`** — All TypeScript interfaces (BookStack entities, API responses, tool param types)

### Request Flow

1. MCP client invokes a tool (e.g., `bookstack_books_list`)
2. `server.ts` routes it to the matching tool handler
3. Tool validates input via Zod schema
4. Validated params passed to `BookStackClient` method
5. Client checks rate limiter (token bucket), then makes HTTP request to BookStack API
6. Response returned as MCP tool result; errors mapped via `errors.ts`

### Configuration

All config comes from environment variables (see `.env.example`). Required vars:
- `BOOKSTACK_BASE_URL` — BookStack instance URL
- `BOOKSTACK_API_TOKEN` — Format: `token_id:token_secret`

In HTTP transport mode, per-request credentials can override the server-level token.

### Adding a New Tool

1. Add types to `src/types.ts`
2. Add a Zod validation schema to `src/validation/validator.ts`
3. Implement the tool function in the appropriate `src/tools/*.ts` file
4. Add an API method to `src/api/client.ts` if needed
5. Register the tool in `src/server.ts`
