#!/usr/bin/env bun

import { createHash, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { BookStackClient } from './api/client';
import {
  type Config,
  ConfigManager,
  type HttpTransportConfig,
  loadHttpTransportConfig,
} from './config/manager';
import { BookResources } from './resources/books';
import { ChapterResources } from './resources/chapters';
import { PageResources } from './resources/pages';
import { SearchResources } from './resources/search';
import { ShelfResources } from './resources/shelves';
import { UserResources } from './resources/users';
import { AttachmentTools } from './tools/attachments';
import { AuditTools } from './tools/audit';
import { BookTools } from './tools/books';
import { ChapterTools } from './tools/chapters';
import { ImageTools } from './tools/images';
import { PageTools } from './tools/pages';
import { PermissionTools } from './tools/permissions';
import { RecycleBinTools } from './tools/recyclebin';
import { RoleTools } from './tools/roles';
import { SearchTools } from './tools/search';
import { ServerInfoTools } from './tools/server-info';
import { ShelfTools } from './tools/shelves';
import { SystemTools } from './tools/system';
import { UserTools } from './tools/users';
import type { MCPResource, MCPSchemaNode, MCPTool } from './types';
import { ErrorHandler } from './utils/errors';
import { Logger, registerSafeNames } from './utils/logger';
import { canonicalBaseUrl, describeBaseUrl } from './utils/rateLimit';
import { ValidationHandler } from './validation/validator';

/**
 * Every property name reachable in a tool's published input schema.
 *
 * Recursive because the names a handler logs are not only the top-level ones: a users
 * listing logs `filters: Object.keys(params.filter)`, whose members are declared one level
 * down under `filter.properties`. `items` and the `oneOf`/`allOf`/`anyOf`/`not` branches are
 * walked for the same reason - a name is part of this server's vocabulary wherever in the
 * schema it was declared.
 *
 * What comes back is a closed set of strings this codebase wrote and already publishes to
 * every client through tools/list. That is what makes it safe to render: see
 * VOCABULARY_KEY_PATTERN in ./utils/logger, which is the thing that consumes it.
 */
function schemaPropertyNames(node: MCPSchemaNode, into: Set<string>): void {
  if (node.properties) {
    for (const [name, child] of Object.entries(node.properties)) {
      into.add(name);
      schemaPropertyNames(child, into);
    }
  }
  if (node.items) {
    schemaPropertyNames(node.items, into);
  }
  for (const branch of [...(node.oneOf ?? []), ...(node.allOf ?? []), ...(node.anyOf ?? [])]) {
    schemaPropertyNames(branch, into);
  }
  if (node.not) {
    schemaPropertyNames(node.not, into);
  }
}

/**
 * Split the names a tool was called with into "ours" and "how many others".
 *
 * The intersection is against the schema this server PUBLISHED for that tool, so `known` is
 * a list of strings this codebase wrote - the caller only chose which of them to use, and
 * every one of them is already public in tools/list. `unknown` is a count for the rest: in
 * strict mode there are none (the schema is closed and the handler rejects them), and in
 * non-strict mode they are the caller's own text and must not be rendered. Either way the
 * operator can see that arguments arrived that this server does not define, which is a fact
 * worth having and is nowhere else in the log.
 */
function splitArgumentNames(tool: MCPTool, args: unknown): { known: string[]; unknown: number } {
  if (typeof args !== 'object' || args === null) {
    return { known: [], unknown: 0 };
  }

  const published = new Set(Object.keys(tool.inputSchema.properties));
  const known: string[] = [];
  let unknown = 0;
  for (const name of Object.keys(args)) {
    if (published.has(name)) {
      known.push(name);
    } else {
      unknown += 1;
    }
  }

  return { known: known.sort(), unknown };
}

/**
 * BookStack MCP Server
 *
 * Provides comprehensive access to BookStack knowledge management system
 * through the Model Context Protocol (MCP).
 *
 * Features:
 * - 56 tools across the supported subset of the BookStack API: books, chapters, pages,
 *   shelves, users, roles, attachments, image gallery, search, recycle bin, content
 *   permissions, the audit log and system info. Not every endpoint family is exposed -
 *   comments, imports, tags, image-gallery `data` and ZIP export are not.
 * - 11 resources for read-only content access
 * - Comprehensive error handling and validation
 * - Rate limiting and retry policies
 */
export class BookStackMCPServer {
  private server: Server;
  private client: BookStackClient;
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private validator: ValidationHandler;
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();

  constructor(configOverrides?: Partial<Config>) {
    const baseConfig = ConfigManager.getInstance().getConfig();

    // Merge overrides
    const config = { ...baseConfig };
    if (configOverrides) {
      if (configOverrides.bookstack) {
        config.bookstack = { ...config.bookstack, ...configOverrides.bookstack };
      }
      // Add other overrides as needed
    }

    this.logger = Logger.getInstance();
    this.errorHandler = new ErrorHandler(this.logger);
    this.validator = new ValidationHandler(config.validation);
    this.client = new BookStackClient(config, this.logger, this.errorHandler);

    // Initialize MCP server
    this.server = new Server(
      {
        name: config.server.name,
        version: config.server.version,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          logging: {},
        },
      }
    );

    this.setupTools();
    this.setupResources();
    this.registerLogVocabulary();
    this.setupHandlers();

    this.logger.info('BookStack MCP Server initialized', {
      tools: this.tools.size,
      resources: this.resources.size,
      // Not `{baseUrl}` - see the note at the same line in ./api/client.ts, and
      // describeBaseUrl() in ./utils/rateLimit.
      ...describeBaseUrl(config.bookstack.baseUrl),
    });
  }

  /**
   * Tell the Logger which names belong to this server, so it can render them.
   *
   * This is the other half of R6-W2's fix. The tool boundary and the tool handlers log
   * names - `tool`, `argument_names`, `fields`, `filters`, `param_names` - and every one of
   * those is read out of an object the caller sent. The call sites below intersect what they
   * log against the schema they just looked up; this registration is what lets the Logger
   * make the same check for the call sites that cannot (a handler deep in ./tools has no way
   * to know, in non-strict mode, that `Object.keys(params)` is no longer its schema's).
   *
   * Registered here rather than in ./tools/*, so that the vocabulary is exactly "what this
   * process actually put in its registries" rather than a list somebody maintains by hand.
   * Runs after setupTools()/setupResources() and before setupHandlers() attaches anything
   * that logs.
   */
  private registerLogVocabulary(): void {
    const names = new Set<string>();
    for (const [name, tool] of this.tools.entries()) {
      names.add(name);
      schemaPropertyNames(tool.inputSchema, names);
    }
    // The URI TEMPLATE ('bookstack://search/{query}'), which is a constant of this codebase.
    // Never a request's URI, whose `{query}` is filled in by the caller.
    for (const uri of this.resources.keys()) {
      names.add(uri);
    }
    registerSafeNames(names);
  }

  /**
   * Setup all tools for BookStack API endpoints
   */
  private setupTools(): void {
    const toolClasses = [
      new BookTools(this.client, this.validator, this.logger),
      new PageTools(this.client, this.validator, this.logger),
      new ChapterTools(this.client, this.validator, this.logger),
      new ShelfTools(this.client, this.validator, this.logger),
      new UserTools(this.client, this.validator, this.logger),
      new RoleTools(this.client, this.validator, this.logger),
      new AttachmentTools(this.client, this.validator, this.logger),
      new ImageTools(this.client, this.validator, this.logger),
      new SearchTools(this.client, this.validator, this.logger),
      new RecycleBinTools(this.client, this.validator, this.logger),
      new PermissionTools(this.client, this.validator, this.logger),
      new AuditTools(this.client, this.validator, this.logger),
      new SystemTools(this.client, this.validator, this.logger),
      new ServerInfoTools(this.logger, this.tools, this.resources),
    ];

    // Register all tools
    toolClasses.forEach((toolClass) => {
      toolClass.getTools().forEach((tool) => {
        this.tools.set(tool.name, tool);
      });
    });

    this.logger.info(`Registered ${this.tools.size} tools`);
  }

  /**
   * Setup all resources for BookStack content access
   */
  private setupResources(): void {
    const resourceClasses = [
      new BookResources(this.client, this.logger),
      new PageResources(this.client, this.logger),
      new ChapterResources(this.client, this.logger),
      new ShelfResources(this.client, this.logger),
      new UserResources(this.client, this.logger),
      new SearchResources(this.client, this.logger),
    ];

    // Register all resources
    resourceClasses.forEach((resourceClass) => {
      resourceClass.getResources().forEach((resource) => {
        this.resources.set(resource.uri, resource);
      });
    });

    this.logger.info(`Registered ${this.resources.size} resources`);
  }

  /**
   * Setup MCP server request handlers
   */
  private setupHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.tools.values()).map((tool) => {
        let enhancedDescription = tool.description;

        // Append usage patterns
        if (tool.usage_patterns && tool.usage_patterns.length > 0) {
          enhancedDescription += `\n\nUsage Patterns:\n${tool.usage_patterns.map((p) => `- ${p}`).join('\n')}`;
        }

        // Append examples
        if (tool.examples && tool.examples.length > 0) {
          enhancedDescription +=
            '\n\nExamples:\n' +
            tool.examples
              .map((e) => `- ${e.description}\n  Input: ${JSON.stringify(e.input)}`)
              .join('\n');
        }

        return {
          name: tool.name,
          description: enhancedDescription,
          inputSchema: tool.inputSchema,
        };
      });

      this.logger.debug(`Listed ${tools.length} tools`);
      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // LOOK IT UP BEFORE LOGGING ANYTHING ABOUT IT.
      //
      // The order is the fix, not a tidy-up. This used to log `Tool called: ${name}` with
      // `{tool: name, argument_names: Object.keys(args)}` FIRST and look the tool up
      // afterwards, on the reasoning that a tool name and an argument name come out of this
      // server's own schemas. At that point in the function they demonstrably do not: they
      // are two caller-supplied strings that have been compared to nothing, and R6-W2's
      // probe put a marker through both of them at the default level - one interpolated into
      // the message, which the redactor does not touch, and one under an allowlisted key.
      // After the lookup there is a registered MCPTool or there is nothing, and that is the
      // difference between reporting a fact and echoing an argument.
      const tool = this.tools.get(name);
      if (!tool) {
        // The name is the caller's, so it is not written - not to the message, not to meta,
        // not at any level. Its LENGTH is: an operator watching a client fail against this
        // server needs to see the calls arriving and be able to tell "an empty name" from
        // "a plausible typo" from "someone spraying 4KB strings at the dispatcher". The
        // caller is told the actual name in the error, on the channel they sent it on.
        this.logger.warn('Tool call rejected: unknown tool', { tool_name_length: name.length });
        throw new Error(`Unknown tool: ${name}`);
      }

      // `tool.name` rather than `name`: byte-identical here (it is the Map key), and it is
      // the registered constant rather than the string that arrived, which is what the next
      // person editing this line inherits.
      //
      // The SHAPE of the call, never the call's values. This line used to log
      // `{arguments: args}` at info - the default level - which put a new account's
      // plaintext password (bookstack_users_create), whole page bodies, and entire base64
      // uploads (up to the 70 MiB body ceiling, duplicated per call) into the operator's
      // logs, durably and by default. Which arguments were supplied identifies what was
      // asked for, which is what an audit line needs; the values are the caller's secrets
      // and content, which it does not.
      const { known, unknown } = splitArgumentNames(tool, args);
      this.logger.info('Tool called', {
        tool: tool.name,
        // Intersected with the tool's published schema, so these are this server's names
        // that the caller used - not the caller's names. The difference only shows up when
        // VALIDATION_STRICT_MODE is off, because then nothing downstream rejects an
        // unknown key either, and the handler's own `fields: Object.keys(params)` line
        // would have carried it. Unknown ones are counted rather than named.
        argument_names: known,
        ...(unknown > 0 ? { unknown_argument_count: unknown } : {}),
      });

      try {
        const result = await tool.handler(args || {});
        this.logger.info('Tool completed successfully', { tool: tool.name });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // Pass the Error itself rather than its message/stack strings: the logger
        // reduces it to error_name/error_code/error_status plus a frame-checked
        // stack. Handing it pre-stringified would be redacted down to a size and
        // lose the type/status that make the line useful.
        this.logger.error('Tool failed', { tool: tool.name, err: error });
        throw this.errorHandler.handleError(error);
      }
    });

    // List resources handler
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = Array.from(this.resources.values()).map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));

      this.logger.debug(`Listed ${resources.length} resources`);
      return { resources };
    });

    // Read resource handler
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      // MATCH BEFORE LOGGING, AND NEVER LOG THE URI.
      //
      // This used to open with `logger.info('Resource requested: ' + uri)`, and R6-W2 is
      // that one line. A resource URI is not an identifier here, it is a TEMPLATE with the
      // caller's text substituted in: `bookstack://search/{query}` carries the search string
      // in its path, so an ordinary, successful read of the search resource wrote the
      // caller's query - a client name, a case reference, a phrase copied out of a document -
      // to the operator's log at the default level, three times over (request, success,
      // failure). It was in the message rather than in meta, so the redactor never saw it.
      //
      // The template is a constant of this codebase; the URI is the caller's. So the
      // template is what gets logged, plus the LENGTH of what filled it in.
      const matched = this.matchResource(uri);

      if (!matched) {
        this.logger.warn('Resource read rejected: unknown resource', { uri_length: uri.length });
        throw new Error(`Unknown resource: ${uri}`);
      }

      const { resource, facts } = matched;
      this.logger.info('Resource requested', { resource: resource.uri, ...facts });

      try {
        const result = await resource.handler(uri);
        this.logger.info('Resource read successfully', { resource: resource.uri, ...facts });

        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType,
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // The Error itself, not `{error: message, stack}`: the logger keeps the name, code,
        // status and frames and drops only the prose. The old shape handed it two strings,
        // and the message of a search failure quotes the query that failed.
        this.logger.error('Resource read failed', { resource: resource.uri, ...facts, err: error });
        throw this.errorHandler.handleError(error);
      }
    });
  }

  /**
   * Find the registered resource whose URI template `uri` is an instance of, and describe
   * what filled the template in without reproducing any of it.
   *
   * The facts are keyed by the template's own placeholder names, so the search resource
   * reports `query_length` and a book resource reports `id_length`. That is derived from the
   * template rather than listed here on purpose: a resource added next year gets the same
   * treatment without anybody remembering to come back, and the ONLY thing a placeholder can
   * ever contribute to a log line is a number.
   */
  private matchResource(
    uri: string
  ): { resource: MCPResource; facts: Record<string, number> } | undefined {
    for (const [template, resource] of this.resources.entries()) {
      if (!template.includes('{')) {
        if (template === uri) {
          return { resource, facts: {} };
        }
        continue;
      }

      // The same rewrite this handler has always used - `{placeholder}` becomes a
      // one-segment capture - with the placeholder NAMES kept alongside it, in the order
      // their groups will come back in.
      const placeholders = [...template.matchAll(/\{([^}]+)\}/g)].map((found) => found[1]);
      const pattern = template.replace(/\{[^}]+\}/g, '([^/]+)');
      const match = new RegExp(`^${pattern}$`).exec(uri);
      if (!match) {
        continue;
      }

      const facts: Record<string, number> = {};
      placeholders.forEach((placeholder, index) => {
        facts[`${placeholder}_length`] = (match[index + 1] ?? '').length;
      });
      return { resource, facts };
    }

    return undefined;
  }

  /**
   * Connect to a transport
   */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Shutdown the server gracefully
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down BookStack MCP Server...');

    try {
      await this.server.close();
      this.logger.info('Server shutdown complete');
    } catch (error) {
      this.logger.error('Error during shutdown', error);
    }
  }

  /**
   * Get server health status
   */
  async getHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    checks: Array<{ name: string; healthy: boolean; message?: string }>;
  }> {
    const checks = [
      {
        name: 'bookstack_connection',
        healthy: await this.client.healthCheck(),
        message: 'BookStack API connection',
      },
      {
        name: 'tools_loaded',
        healthy: this.tools.size > 0,
        message: `${this.tools.size} tools loaded`,
      },
      {
        name: 'resources_loaded',
        healthy: this.resources.size > 0,
        message: `${this.resources.size} resources loaded`,
      },
    ];

    const status = checks.every((check) => check.healthy) ? 'healthy' : 'unhealthy';

    return { status, checks };
  }
}

/**
 * Message shown when the HTTP transport is asked to start without an inbound secret.
 */
export const MISSING_AUTH_TOKEN_MESSAGE =
  'MCP_AUTH_TOKEN is not set. The HTTP transport refuses to start without an inbound ' +
  'secret, because POST /message dispatches all 56 tools - including permanent-delete, ' +
  'user, role and permission operations - using the configured BOOKSTACK_API_TOKEN. ' +
  'Set MCP_AUTH_TOKEN to a random secret (e.g. `openssl rand -hex 32`) and send it as ' +
  '"Authorization: Bearer <token>", or use MCP_TRANSPORT=stdio, which has no network ' +
  'surface.';

/**
 * body-parser tags its failures with a `type` (e.g. 'entity.too.large') and an HTTP
 * `status`. Neither is on the `Error` interface, so narrow to this shape rather than
 * reaching through `any`.
 */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/** Recognise an error raised by express.json() as opposed to anything else. */
function asBodyParserError(error: unknown): BodyParserError | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const candidate: BodyParserError = error;
  return typeof candidate.type === 'string' ? candidate : undefined;
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * The digests, not the raw strings, are what get compared: timingSafeEqual() throws on
 * length-mismatched inputs, and guarding that with a length check would itself leak the
 * expected length. Hashing first makes every comparison a fixed 32 bytes.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/** Pull the credential out of an `Authorization: Bearer <token>` header. */
function extractBearerToken(header: string | undefined): string | undefined {
  // The auth scheme is case-insensitive per RFC 7235.
  const match = header?.match(/^Bearer\s+(\S.*)$/i);
  return match?.[1]?.trim();
}

/**
 * Require `Authorization: Bearer <MCP_AUTH_TOKEN>` on a route.
 *
 * This is *inbound* authentication and is unrelated to the x-bookstack-token header:
 * that one selects which outbound BookStack credential to spend, which is a choice only
 * an already-authenticated caller may make.
 */
function requireBearerAuth(expected: string): RequestHandler {
  return (req, res, next) => {
    const presented = extractBearerToken(req.headers.authorization);

    if (presented === undefined || !secretsMatch(presented, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="bookstack-mcp"');
      res.status(401).json({
        error: 'Unauthorized',
        message:
          'POST /message requires an "Authorization: Bearer <MCP_AUTH_TOKEN>" header ' +
          'carrying the secret configured on this server.',
      });
      return;
    }

    next();
  };
}

/**
 * Turn express.json() failures into JSON, not Express's default HTML error page.
 */
function createBodyErrorHandler(limitBytes: number): ErrorRequestHandler {
  return (error, _req, res, next) => {
    const parseError = asBodyParserError(error);

    if (!parseError || res.headersSent) {
      next(error);
      return;
    }

    if (parseError.type === 'entity.too.large') {
      res.status(413).json({
        error: 'Payload Too Large',
        message:
          `Request body exceeds the ${limitBytes} byte limit for POST /message. ` +
          'Raise HTTP_BODY_LIMIT, or upload large files with the tools\' "file_path" ' +
          'parameter (see BOOKSTACK_UPLOAD_ROOT) instead of inlining base64.',
        limitBytes,
      });
      return;
    }

    res.status(parseError.status ?? 400).json({
      error: 'Bad Request',
      message: `Could not read the JSON request body: ${parseError.message}`,
    });
  };
}

export interface HttpAppOptions {
  /** Base configuration: BookStack credentials, server identity. */
  config: Config;
  /** Transport-scoped settings: inbound secret and body ceiling. */
  http: HttpTransportConfig;
}

/**
 * READINESS PROBE BUDGET.
 *
 * `GET /health` is unauthenticated by design, and it makes a real upstream `GET /system`
 * call. Those two facts together are the problem these constants solve: the outbound bucket
 * is shared per BookStack identity (see src/utils/rateLimit.ts), so before this, every
 * anonymous health request queued its own upstream check in the SAME FIFO as authenticated
 * tool calls. Any peer that could reach the port could therefore push arbitrary work ahead
 * of real traffic - at the default 60/min, a burst of a few hundred stalls authenticated
 * operations for minutes - while each waiter pinned a request and a promise. One HTTP
 * request must not equal one queued upstream check.
 */

/**
 * How long a readiness result is served before the upstream is asked again.
 *
 * Short enough to stay honest: a real probe interval (Kubernetes defaults to 10s) is longer
 * than this, so a legitimate prober is never served a cached answer at all, and a BookStack
 * that has just died is reported unhealthy within 5s. Long enough that a flood collapses to
 * at most 12 upstream calls a minute rather than one per request.
 */
const HEALTH_TTL_MS = 5_000;

/**
 * How many requests may park on one in-flight check before the rest are shed.
 *
 * Coalescing already caps the UPSTREAM cost at one call; this caps the memory cost of the
 * callers waiting for it, which is the other half of the anonymous-pressure path. It only
 * binds when a check is slow (a hung BookStack holds it open for the full request timeout).
 */
const HEALTH_MAX_WAITERS = 32;

/**
 * The oldest cached result a shed caller may be given.
 *
 * The TTL bounds staleness on the normal path; this bounds it on the overload path, so a
 * sustained flood cannot turn the cache into an indefinite "it was fine once" answer. Past
 * this age there is no honest answer to give, so those callers get a 503 that says exactly
 * that rather than a stale one that does not.
 */
const HEALTH_MAX_STALE_MS = 30_000;

/**
 * The clock the readiness cache ages itself by.
 *
 * Monotonic on purpose. `Date.now()` is wall time and can step - NTP correction, a
 * container's clock syncing after resume, an operator fixing a bad RTC - and every step
 * lands directly on the two safety bounds above. Backwards, a snapshot's age shrinks and
 * HEALTH_MAX_STALE_MS stops binding, which is precisely the "prolonged 200 readiness lie"
 * that bound exists to prevent; forwards, a healthy result is thrown away for no reason.
 * `performance.now()` cannot step, so the bounds mean elapsed time and nothing else.
 *
 * Wall time is still what `checked_at` needs - "13:42:01Z" is meaningful to a reader and
 * "1843201.7 ms since this process started" is not - so a snapshot carries both, each used
 * for the one job it is correct for.
 */
function monotonicNow(): number {
  return performance.now();
}

/**
 * The public reason a readiness check that threw is reported with.
 *
 * Fixed text, never the exception's. /health is unauthenticated, and the exceptions
 * reachable here are about this server's own configuration - R5-W2 was exactly this: the
 * route answered an anonymous caller with `BookStack base URL
 * 'https://books.example/api?api_token=…' must not carry a query string...`, echoing the
 * credential out of the config to anyone who could reach the port. The detail belongs in the
 * log, where the redacting Logger writes it for an operator; the caller gets the fact.
 */
export const HEALTH_CHECK_FAILED_MESSAGE =
  'The readiness check could not be completed. This is a fault in this server rather than a ' +
  "verdict about BookStack; see this server's logs for the reason.";

/**
 * Build the Express app that serves the HTTP transport.
 *
 * Exported so tests can drive the real routes - middleware order included - over real
 * HTTP. The integration suites call tool handlers directly and never cross this parser,
 * which is precisely how an unbounded express.json() (~100 KB default) shipped while the
 * suite stayed green.
 *
 * Fails closed: without an inbound secret there is no app to listen with, so "no auth
 * configured" cannot degrade into "no auth required".
 */
export function createHttpApp(options: HttpAppOptions): express.Express {
  const { config, http } = options;
  const authToken = http.authToken;

  if (!authToken) {
    throw new Error(MISSING_AUTH_TOKEN_MESSAGE);
  }

  // Same reason, same shape: no app, so nothing to listen with. `ConfigSchema` already
  // refuses a base URL canonicalBaseUrl() would - this is the second half of that check,
  // for the callers that build a `Config` by hand and never cross the schema (the tests
  // below, and any embedder). A base URL the client cannot be constructed with means the
  // process could never serve a single tool call, so it must not reach a listening socket
  // and then admit that one unauthenticated /health at a time.
  canonicalBaseUrl(config.bookstack.baseUrl);

  const app = express();
  let mcpServer: BookStackMCPServer | undefined;

  // Root endpoint - the cheap LIVENESS probe: is this process up and serving?
  // Unauthenticated on purpose, so it carries nothing an anonymous caller should not see -
  // no URLs, no credentials, no config - and, just as deliberately, it touches no upstream.
  // Point per-second checks here; /health is the readiness probe and costs a real call.
  app.get('/', (_req, res) => {
    res.json({
      name: config.server.name,
      version: config.server.version,
      status: 'running',
      mcp: true,
      endpoints: {
        health: '/health (readiness: checks BookStack connectivity)',
        message: '/message (POST, requires an Authorization: Bearer header)',
      },
      documentation: 'Send MCP protocol messages to POST /message',
    });
  });

  /** One readiness answer, with the instant it was true at. */
  interface HealthSnapshot {
    report: Awaited<ReturnType<BookStackMCPServer['getHealth']>>;
    /** Wall clock, for `checked_at` only: a timestamp a reader can act on. */
    at: number;
    /** Monotonic reading, for every age comparison. See monotonicNow(). */
    monotonicAt: number;
  }

  /** The last completed check. Absent until one has finished. */
  let lastCheck: HealthSnapshot | undefined;
  /** The check currently running, if any. The single-flight slot. */
  let checkInFlight: Promise<HealthSnapshot> | undefined;
  /** Requests currently parked on `checkInFlight`. */
  let healthWaiters = 0;

  /**
   * The cached MCP server used for readiness checks.
   *
   * Built from the app's own config rather than re-reading the singleton, so the readiness
   * probe reports on the BookStack this app was actually configured with. Cached across
   * requests because constructing one registers all 56 tools and 11 resources - work an
   * anonymous caller must not be able to trigger per request.
   */
  function healthServer(): BookStackMCPServer {
    if (!mcpServer) {
      mcpServer = new BookStackMCPServer({ bookstack: config.bookstack });
    }
    return mcpServer;
  }

  /**
   * Run at most ONE upstream readiness check at a time; everyone else joins that one.
   *
   * This is the coalescing point. N concurrent callers produce one `GET /system`, so they
   * spend one token from the shared outbound bucket between them instead of N, and cannot
   * push N entries into the FIFO ahead of authenticated tool calls.
   */
  function checkReadiness(): Promise<HealthSnapshot> {
    if (!checkInFlight) {
      checkInFlight = healthServer()
        .getHealth()
        .then((report) => {
          const snapshot: HealthSnapshot = {
            report,
            at: Date.now(),
            monotonicAt: monotonicNow(),
          };
          lastCheck = snapshot;
          return snapshot;
        })
        .finally(() => {
          // Cleared on settle, success or failure: the TTL - not this slot - is what
          // prevents the next caller from immediately re-checking.
          checkInFlight = undefined;
        });
    }
    return checkInFlight;
  }

  /** How long ago a snapshot was taken, by the clock the bounds are enforced on. */
  function ageMs(snapshot: HealthSnapshot): number {
    return Math.max(0, Math.round(monotonicNow() - snapshot.monotonicAt));
  }

  /** Answer with a snapshot, stating how old it is rather than implying it is current. */
  function sendHealth(res: Response, snapshot: HealthSnapshot): void {
    res.status(snapshot.report.status === 'healthy' ? 200 : 503).json({
      ...snapshot.report,
      checked_at: new Date(snapshot.at).toISOString(),
      age_ms: ageMs(snapshot),
    });
  }

  /**
   * Readiness check. Unauthenticated: reports only booleans about this server's own state.
   *
   * Honesty is preserved on every path. An unreachable BookStack still yields 503, because
   * the check itself is unchanged - only its frequency is bounded. A served result always
   * carries `checked_at`/`age_ms`, is at most HEALTH_TTL_MS old on the normal path, and can
   * never be served indefinitely: past HEALTH_MAX_STALE_MS a shed caller is told the truth
   * (503, no answer available) instead of a comfortable old one.
   */
  app.get('/health', async (_req, res) => {
    try {
      if (lastCheck && ageMs(lastCheck) < HEALTH_TTL_MS) {
        sendHealth(res, lastCheck);
        return;
      }

      // Shed load rather than park an unbounded number of anonymous callers on a check
      // that may be waiting out a hung BookStack.
      if (healthWaiters >= HEALTH_MAX_WAITERS) {
        if (lastCheck && ageMs(lastCheck) < HEALTH_MAX_STALE_MS) {
          sendHealth(res, lastCheck);
          return;
        }
        res.status(503).json({
          status: 'unhealthy',
          error:
            `The readiness check is saturated: ${healthWaiters} requests are already waiting ` +
            'on the current BookStack check and no recent result is available. Use GET / for ' +
            'liveness, and probe /health no more often than every few seconds.',
        });
        return;
      }

      healthWaiters += 1;
      try {
        sendHealth(res, await checkReadiness());
      } finally {
        healthWaiters -= 1;
      }
    } catch (error) {
      // NEVER `(error as Error).message` here. This endpoint is unauthenticated, and the
      // text of an exception raised on this path describes this server's own configuration -
      // including, verbatim, the base URL it was given. Through the redacting Logger for the
      // operator; a fixed reason for the caller. R5-W2.
      Logger.getInstance().error('Readiness check failed', { err: error });
      res.status(503).json({
        status: 'unhealthy',
        error: HEALTH_CHECK_FAILED_MESSAGE,
      });
    }
  });

  app.post(
    '/message',
    // Order is load-bearing. Authentication runs before express.json() below, so an
    // unauthenticated caller is turned away at the header - it can never make this
    // process buffer a body up to the ceiling, nor reach a BookStackMCPServer (and
    // therefore the operator's BookStack token).
    requireBearerAuth(authToken),
    express.json({ limit: http.bodyLimitBytes }),
    createBodyErrorHandler(http.bodyLimitBytes),
    // `req`/`res` are annotated because Express stops inferring handler parameter types
    // for a chain that contains a 4-arity error handler; without them they would be
    // implicitly `any`.
    async (req: Request, res: Response) => {
      try {
        // Per-request credential selection. Reachable only by callers that cleared the
        // bearer check above; it is an outbound-request surface, since x-bookstack-url
        // decides which host this server will talk to on the caller's behalf.
        const bookstackUrl = req.headers['x-bookstack-url'] as string;
        const bookstackToken = req.headers['x-bookstack-token'] as string;

        const configOverrides: Partial<Config> = {
          bookstack: {
            baseUrl: bookstackUrl || config.bookstack.baseUrl,
            apiToken: bookstackToken || config.bookstack.apiToken,
            timeout: config.bookstack.timeout,
          },
        };

        const server = new BookStackMCPServer(configOverrides);
        // Omitting `sessionIdGenerator` selects the SDK's stateless mode, which is exactly
        // what passing it as `undefined` did; `exactOptionalPropertyTypes` forbids the
        // explicit-undefined form since the option is declared as `sessionIdGenerator?: () => string`.
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        // The SDK declares `StreamableHTTPServerTransport implements Transport`, but exposes
        // onclose/onerror/onmessage/sessionId as `T | undefined` accessors, which
        // `exactOptionalPropertyTypes` rejects against Transport's `prop?: T` optionals.
        // The class does satisfy Transport at runtime, so assert across that gap.
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        // Route through Logger, not console.error: the logger redacts (this error can
        // carry caller-controlled text) and owns the stream. A bare console.error is
        // both unredacted and outside the transport's stream discipline.
        Logger.getInstance().error('Error handling MCP request', { err: error });
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Internal Server Error',
            message: 'The server failed to handle this MCP message.',
          });
        }
      }
    }
  );

  // 404 handler for unknown routes
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: `${req.method} ${req.path} is not a valid endpoint`,
      availableEndpoints: {
        root: 'GET /',
        health: 'GET /health',
        message: 'POST /message',
      },
    });
  });

  return app;
}

/** Build and start the HTTP transport. Throws if it is not safe to start. */
function startHttpServer(): void {
  const config = ConfigManager.getInstance().getConfig();
  const httpConfig = loadHttpTransportConfig();
  const app = createHttpApp({ config, http: httpConfig });
  const port = config.server.port;

  app.listen(port, () => {
    // Logger, never console.log: console.log writes to STDOUT. This path only runs
    // under the HTTP transport today, but a stray stdout write is exactly what
    // corrupted the stdio JSON-RPC stream once already (dotenv's banner), so the
    // rule is that nothing in this process writes to stdout except MCP protocol.
    const logger = Logger.getInstance();
    logger.info(`BookStack MCP Server listening on port ${port}`);
    logger.info(
      `POST /message requires an Authorization: Bearer header; body limit ${httpConfig.bodyLimitBytes} bytes`
    );
  });
}

// Start server if run directly
if (import.meta.main) {
  const transport = process.env.MCP_TRANSPORT || 'http';

  if (transport === 'stdio') {
    const server = new BookStackMCPServer();
    const stdioTransport = new StdioServerTransport();

    server.connect(stdioTransport).catch((error) => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });

    console.error('BookStack MCP Server started and listening on stdio');

    // Handle graceful shutdown
    process.on('SIGINT', () => server.shutdown());
    process.on('SIGTERM', () => server.shutdown());
  } else {
    try {
      startHttpServer();
    } catch (error) {
      // Fail closed: a misconfigured HTTP transport must not start at all, since the
      // failure mode is an open proxy to the operator's BookStack admin token.
      console.error(`Failed to start HTTP transport: ${(error as Error).message}`);
      process.exit(1);
    }
  }
}

export default BookStackMCPServer;
