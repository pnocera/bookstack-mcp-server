import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import { Logger } from '../utils/logger';
import { canonicalBaseUrl } from '../utils/rateLimit';
import { VERSION } from '../version';

// Load environment variables.
//
// `quiet: true` is load-bearing, not cosmetic. Since v17 dotenv announces itself
// with "◇ injected env (N) from .env // tip: …" via console.log — i.e. on STDOUT.
// Under the stdio transport stdout carries the MCP JSON-RPC stream, so that
// banner lands mid-protocol and corrupts the session before it starts. This is
// the same hazard that put Winston on stderr; dotenv is the other writer that
// has to be silenced.
dotenvConfig({ quiet: true });

/**
 * Reject a BOOKSTACK_BASE_URL this server could never actually serve traffic with.
 *
 * The rule is canonicalBaseUrl()'s, imported rather than restated. That is the point:
 * `BookStackClient` canonicalises the base URL it is built with and the limiter registry
 * keys on the result, so a URL canonicalBaseUrl() refuses is a URL the server cannot use -
 * and a second, hand-written copy of "which URLs are usable" here would drift from the one
 * that decides. `z.string().url()` was that gap: it accepts userinfo, a query and a fragment,
 * all of which canonicalBaseUrl() refuses.
 *
 * R5-W2 is what the gap cost. The schema admitted `https://books.example/api?api_token=…`,
 * so the process started and listened; the first unauthenticated `GET /health` then built the
 * client, hit the refusal, and returned the caught message - credential included - to an
 * anonymous caller, from a process that could never have served a tool call. Validating here
 * moves that from a runtime surprise on an unauthenticated endpoint to a startup failure,
 * before anything binds a port.
 *
 * No import cycle: ../utils/rateLimit imports nothing from this repo (only node:crypto), so
 * the helper stays beside the identity it defines rather than moving somewhere neutral.
 *
 * This validates without transforming. Canonicalisation stays at the single point that
 * decides identity (getSharedRateLimiter/BookStackClient), so what an operator configured is
 * what getSummary() reports back to them, and `Partial<Config>` overrides - which never pass
 * through this schema - cannot come to depend on the schema having rewritten a value.
 */
const baseUrlCheck = (value: string, ctx: z.RefinementCtx): void => {
  try {
    canonicalBaseUrl(value);
  } catch (error) {
    // canonicalBaseUrl()'s refusals interpolate NOTHING - not the userinfo or query they
    // are rejecting, and since R6-W3 not the scheme, host or path either, because a base
    // URL's path is arbitrary operator text that can carry a proxy capability. So the
    // message is a constant naming this setting and the offending component, which is safe
    // both to log and to hand back to an operator. See the note above canonicalBaseUrl() in
    // ../utils/rateLimit for why no component of a supplied URL is quotable.
    ctx.addIssue({ code: 'custom', message: (error as Error).message });
  }
};

/**
 * Configuration schema using Zod for validation
 */
export const ConfigSchema = z.object({
  bookstack: z.object({
    baseUrl: z.string().superRefine(baseUrlCheck).default('http://localhost:8080/api'),
    apiToken: z
      .string()
      .min(1, 'BookStack API token is required - set BOOKSTACK_API_TOKEN environment variable'),
    timeout: z.number().positive().default(30000),
  }),
  server: z.object({
    name: z.string().default('bookstack-mcp-server'),
    version: z.string().default(VERSION),
    port: z.number().positive().default(3000),
  }),
  rateLimit: z.object({
    requestsPerMinute: z.number().positive().default(60),
    burstLimit: z.number().positive().default(10),
  }),
  validation: z.object({
    enabled: z.boolean().default(true),
    // Strict by default: on a schema failure ValidationHandler either throws (strict) or
    // logs and forwards the ORIGINAL params (non-strict). Non-strict made every schema in
    // the repo advisory - invalid input reached BookStack and came back a 422 - and, worse,
    // silently skipped the `.transform()`s, which carry real logic (`date_from` ->
    // `created_at:gte`, boolean -> 1/0 for tinyint filters that otherwise match the
    // OPPOSITE rows). Opt out with VALIDATION_STRICT_MODE=false.
    strictMode: z.boolean().default(true),
  }),
  // Consumed by Logger.configure(), called from loadConfig() below. Keep this
  // shape in step with LoggingOptions in ../utils/logger.
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    format: z.enum(['json', 'pretty']).default('pretty'),
  }),
  development: z.object({
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    debug: z.boolean().default(false),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Default ceiling for a POST /message body, in bytes.
 *
 * Sized from the largest upload the tools themselves promise to accept ("at most
 * 50000 KB", per src/tools/images.ts and src/tools/attachments.ts), because the body
 * parser sees the *encoded* form, not the file:
 *
 *   50,000 KB source                     =  51,200,000 bytes
 *   base64 of that: ceil(n / 3) * 4      =  68,266,668 bytes  (~65.1 MiB)
 *   + the JSON-RPC envelope around it (method, params, field names, quotes)
 *   -> round up to 70 MiB                =  73,400,320 bytes  (~5 MiB of headroom)
 *
 * The value matters because Express's default is ~100 KB: leaving `express.json()`
 * unbounded silently capped every inline upload at roughly 75 KB of real data and
 * answered anything larger with a 413 raised *before* MCP dispatch, while the tool
 * schemas advertised a limit 600x higher.
 *
 * This is a ceiling, not a target. Prefer `file_path` + BOOKSTACK_UPLOAD_ROOT for
 * large uploads; raise or lower it with HTTP_BODY_LIMIT.
 */
export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 70 * 1024 * 1024; // 73,400,320

/**
 * Settings that exist only for the HTTP transport.
 *
 * Deliberately kept out of `ConfigSchema`: `Config` is handed to the BookStack client,
 * the validator and all 56 tools, and is merged per request in the /message handler
 * (`Partial<Config>` overrides). The inbound secret has no business travelling with it,
 * and the body ceiling means nothing under stdio.
 */
export const HttpTransportConfigSchema = z.object({
  /**
   * Maximum accepted POST /message body. Set via HTTP_BODY_LIMIT (bytes).
   */
  bodyLimitBytes: z
    .number({ error: 'HTTP_BODY_LIMIT must be a byte count (a positive integer)' })
    .int()
    .positive()
    .default(DEFAULT_HTTP_BODY_LIMIT_BYTES),
  /**
   * Shared secret a caller must present as `Authorization: Bearer <token>` on
   * POST /message. Set via MCP_AUTH_TOKEN.
   *
   * Optional *here* only so that stdio never has to carry one; the HTTP transport
   * itself fails closed when it is absent (see createHttpApp in ../server.ts). It is
   * inbound authentication, independent of BOOKSTACK_API_TOKEN, which is the
   * outbound credential this server spends on the caller's behalf.
   */
  authToken: z.string().min(1).optional(),
});

export type HttpTransportConfig = z.infer<typeof HttpTransportConfigSchema>;

/** The subset of `process.env` this module reads; injectable so it can be tested. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Read a boolean environment variable, deferring to the schema when it is unset.
 *
 * Returning `undefined` for an absent variable is the whole point: it leaves the Zod
 * `.default()` as the single source of truth. The alternative - computing a boolean here
 * for every case - silently overrides the schema default, so the `.default()` never fires
 * and moving it has no effect. That trap is what made `strictMode` look like it defaulted
 * to whatever the schema said while `=== 'true'` actually pinned it to `false` when unset.
 * It is the same family as this repo's earlier `config.validation?.enabled || true`, which
 * could never yield `false`.
 *
 * A present variable is `false` only for the exact string 'false', matching the existing
 * VALIDATION_ENABLED convention; anything else present reads as `true`.
 */
function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  return value !== 'false';
}

/**
 * Read a numeric environment variable, deferring to the schema when it is unset.
 *
 * Same contract as envFlag(): `undefined` for an absent variable, so the Zod
 * `.default()` stays the single source of truth. Note the older `parseInt(process.env.X
 * || '30000', 10)` entries above do the opposite - they duplicate each default in two
 * places, so the `.default()` beside them is dead code. Do not copy that pattern.
 *
 * A present-but-unparseable value yields NaN rather than a silent fallback: the schema
 * then rejects it by name, which beats booting on a limit the operator did not choose.
 */
function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return Number(value);
}

/**
 * Read a string environment variable, treating blank as absent.
 *
 * Blank has to mean absent: docker-compose passes `MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:-}`,
 * which hands us '' when the operator has not set one. Mapping that to `undefined` lets
 * the transport fail closed with an actionable message instead of a schema violation.
 */
function envString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Render Zod issues as `path: message` pairs for operator-facing errors. */
function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue: z.core.$ZodIssue) => `${issue.path.join('.')}: ${issue.message}`);
}

/**
 * Load the HTTP transport settings from the environment.
 *
 * Standalone rather than a ConfigManager method, and parameterised by `env`, so that
 * callers (and tests) can resolve it without touching the process-wide singleton.
 */
export function loadHttpTransportConfig(env: EnvSource = process.env): HttpTransportConfig {
  try {
    return HttpTransportConfigSchema.parse({
      bodyLimitBytes: envNumber(env.HTTP_BODY_LIMIT),
      authToken: envString(env.MCP_AUTH_TOKEN),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `HTTP transport configuration validation failed: ${formatZodIssues(error).join(', ')}`
      );
    }
    throw error;
  }
}

/**
 * Configuration manager singleton
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: Config;
  private logger: Logger;

  private constructor() {
    this.logger = Logger.getInstance();
    this.config = this.loadConfig();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Load and validate configuration from environment variables
   */
  private loadConfig(): Config {
    const rawConfig = {
      bookstack: {
        baseUrl: process.env.BOOKSTACK_BASE_URL || 'http://localhost:8080/api',
        apiToken: process.env.BOOKSTACK_API_TOKEN || '',
        timeout: parseInt(process.env.BOOKSTACK_TIMEOUT || '30000', 10),
      },
      server: {
        name: process.env.SERVER_NAME || 'bookstack-mcp-server',
        version: process.env.SERVER_VERSION || VERSION,
        port: parseInt(process.env.SERVER_PORT || '3000', 10),
      },
      rateLimit: {
        requestsPerMinute: parseInt(process.env.RATE_LIMIT_REQUESTS_PER_MINUTE || '60', 10),
        burstLimit: parseInt(process.env.RATE_LIMIT_BURST_LIMIT || '10', 10),
      },
      validation: {
        enabled: envFlag(process.env.VALIDATION_ENABLED),
        strictMode: envFlag(process.env.VALIDATION_STRICT_MODE),
      },
      logging: {
        level: process.env.LOG_LEVEL || 'info',
        format: process.env.LOG_FORMAT || 'pretty',
      },
      development: {
        nodeEnv: process.env.NODE_ENV || 'development',
        debug: process.env.DEBUG === 'true',
      },
    };

    try {
      const validatedConfig = ConfigSchema.parse(rawConfig);
      // Hand the validated settings to the logger before logging anything, so this
      // very line already honours LOG_LEVEL / LOG_FORMAT. The logger singleton is
      // necessarily built before the config exists (this class takes it in its own
      // constructor), so it starts on defaults and is reconfigured here — this is
      // the only place LOG_LEVEL / LOG_FORMAT are read.
      this.logger.configure(validatedConfig.logging);
      this.logger.info('Configuration loaded and validated successfully');
      return validatedConfig;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = formatZodIssues(error);
        // `config_errors`, not a bare array: the logger withholds strings whose key
        // does not vouch for them, so an unkeyed array logs as "[redacted: N chars]"
        // and the operator loses the reason their config was refused at exactly the
        // moment they need it. These messages are our own schema text naming the
        // offending variable — never the value, because the one message that could have
        // quoted a credential is canonicalBaseUrl()'s, which interpolates no part of the
        // URL it refuses at all (R6-W3: it used to quote scheme/host/path, and a path
        // carries whatever the deployment put there).
        this.logger.error('Configuration validation failed', { config_errors: errorMessages });
        throw new Error(`Configuration validation failed: ${errorMessages.join(', ')}`);
      }
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Reload configuration from environment
   */
  reload(): Config {
    this.config = this.loadConfig();
    return this.config;
  }

  /**
   * Get configuration summary for logging
   */
  getSummary(): object {
    const config = this.getConfig();
    return {
      bookstack: {
        baseUrl: config.bookstack.baseUrl,
        hasApiToken: !!config.bookstack.apiToken,
        timeout: config.bookstack.timeout,
      },
      server: config.server,
      rateLimit: config.rateLimit,
      validation: config.validation,
      logging: config.logging,
      development: config.development,
    };
  }
}

export default ConfigManager;
