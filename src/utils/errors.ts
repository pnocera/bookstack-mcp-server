import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { AxiosError } from 'axios';
import type { ZodError } from 'zod';
import type { Logger } from './logger';

/**
 * Loosely-typed view of the error shapes this handler inspects at runtime.
 */
interface ErrorLike {
  isAxiosError?: boolean;
  name?: string;
  message?: string;
  stack?: string;
  response?: { status?: number; headers?: unknown };
}

/**
 * HTTP statuses that represent a *transient* upstream condition, i.e. one where an
 * identical request has a genuine chance of succeeding later.
 *
 * 429 is the one BookStack actually produces in normal operation: it throttles to 180
 * requests/minute per user and the token is frequently shared.
 */
const RETRYABLE_STATUS_CODES: readonly number[] = [429, 500, 502, 503, 504];

/** Upper bound on a server-directed wait we are willing to believe (10 minutes). */
const MAX_SERVER_DIRECTED_WAIT_MS = 600_000;

/**
 * Retry hints recovered from a failed response.
 *
 * `retryAfterMs` is a *server-directed* wait: it is only ever set when the upstream
 * actually told us how long to wait, so callers can distinguish "the server said 3s"
 * from "we have no idea, back off on our own schedule".
 */
export interface RetryInfo {
  status?: number;
  method?: string;
  retryAfterMs?: number;
  rateLimitRemaining?: number;
}

/** Narrow an unknown value to an indexable object without asserting `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read a single header case-insensitively from an unknown header bag.
 *
 * Axios hands back either a plain object or an AxiosHeaders instance, and values may
 * arrive as a string, a number, or (for repeated headers) an array.
 */
function readHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) {
    return undefined;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return value[0];
    }
  }

  return undefined;
}

/**
 * Parse `Retry-After`, which RFC 9110 allows in two forms: a delay in seconds
 * ("120", what Laravel/BookStack sends) or an absolute HTTP-date.
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const raw = value.trim();
  if (raw.length === 0) {
    return undefined;
  }

  // Delay-seconds form.
  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) * 1000;
  }

  // HTTP-date form: convert the absolute instant into a delay from now.
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - Date.now());
}

/**
 * Parse `X-RateLimit-Reset`. Laravel's throttle middleware emits a Unix timestamp in
 * seconds, but a bare delta-seconds value is common enough elsewhere to be worth
 * tolerating; anything small enough to not be a plausible epoch is read as a delta.
 */
function parseRateLimitReset(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const seconds = Number.parseInt(value.trim(), 10);
  // ~1e9 seconds is 2001; any value at least that large is an absolute epoch.
  if (seconds >= 1_000_000_000) {
    return Math.max(0, seconds * 1000 - Date.now());
  }

  return seconds * 1000;
}

/** Clamp a server-directed wait to something sane, discarding absurd values. */
function sanitizeWait(waitMs: number | undefined): number | undefined {
  if (waitMs === undefined || !Number.isFinite(waitMs) || waitMs < 0) {
    return undefined;
  }
  return Math.min(waitMs, MAX_SERVER_DIRECTED_WAIT_MS);
}

/**
 * Error handler for BookStack MCP Server
 */
export class ErrorHandler {
  private errorMappings = {
    400: { type: 'validation_error', message: 'Invalid request parameters' },
    401: { type: 'authentication_error', message: 'Invalid or missing authentication token' },
    403: { type: 'permission_error', message: 'Insufficient permissions for this operation' },
    404: { type: 'not_found_error', message: 'Requested resource not found' },
    422: { type: 'validation_error', message: 'Validation failed' },
    429: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    500: { type: 'server_error', message: 'Internal server error' },
    502: { type: 'server_error', message: 'Bad gateway' },
    503: { type: 'server_error', message: 'Service unavailable' },
    504: { type: 'server_error', message: 'Gateway timeout' },
  };

  constructor(private logger: Logger) {}

  /**
   * Handle Axios errors specifically
   */
  handleAxiosError(error: AxiosError): McpError {
    const status = error.response?.status;
    const mapping = this.errorMappings[status as keyof typeof this.errorMappings] || {
      type: 'unknown_error',
      message: 'Unknown error occurred',
    };

    // The client's response interceptor converts every AxiosError into an McpError before
    // request() ever sees it, so the retry hints must be carried across on the McpError -
    // otherwise the original headers are gone by the time we decide whether to retry.
    const retry = this.extractRetryInfo(error.response?.headers, status);

    const mcpError = new McpError(this.mapToMCPErrorCode(status), mapping.message, {
      type: mapping.type,
      status,
      details: error.response?.data,
      url: error.config?.url,
      method: error.config?.method?.toUpperCase(),
      ...retry,
    });

    this.logger.error('Axios error handled', {
      status,
      type: mapping.type,
      url: error.config?.url,
      method: error.config?.method,
      message: error.message,
    });

    return mcpError;
  }

  /**
   * Handle generic errors
   */
  handleError(error: unknown): McpError {
    if (error instanceof McpError) {
      return error;
    }

    const err = error as ErrorLike;

    if (err.isAxiosError) {
      return this.handleAxiosError(error as AxiosError);
    }

    // Handle validation errors from Zod
    if (err.name === 'ZodError') {
      const validationDetails = (error as ZodError).issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));

      return new McpError(ErrorCode.InvalidParams, 'Validation failed', {
        type: 'validation_error',
        validation: validationDetails,
      });
    }

    // Handle generic errors
    const mcpError = new McpError(
      ErrorCode.InternalError,
      err.message || 'An unexpected error occurred',
      {
        type: 'internal_error',
        stack: err.stack,
      }
    );

    // The error itself, not its strings. `name` is not a name the logger can vouch for -
    // it is the key a user's display name arrives under, so the allowlist in
    // src/utils/logger.ts reports its size like any other unvouched-for string, and this
    // line would have lost the one fact that makes it worth reading. Handing over the Error
    // gets `error_name`/`error_code`/`error_status`/`error_stack` through toSafeError()
    // instead, which is more than the three strings carried and none of it prose. Same
    // shape as src/server.ts's tool-boundary catch.
    this.logger.error('Generic error handled', { err: error });

    return mcpError;
  }

  /**
   * Map HTTP status codes to MCP error codes
   */
  private mapToMCPErrorCode(status?: number): ErrorCode {
    switch (status) {
      case 400:
      case 422:
        return ErrorCode.InvalidParams;
      case 401:
        return ErrorCode.InvalidRequest;
      case 403:
        return ErrorCode.InvalidRequest;
      case 404:
        return ErrorCode.InvalidRequest;
      case 429:
        return ErrorCode.InternalError;
      case 500:
      case 502:
      case 503:
      case 504:
        return ErrorCode.InternalError;
      default:
        return ErrorCode.InternalError;
    }
  }

  /**
   * Pull the retry hints out of a response's headers.
   *
   * `Retry-After` is authoritative when present. BookStack (via Laravel's throttle
   * middleware) sends it alongside `X-RateLimit-Reset` on a 429; `X-RateLimit-Reset` is
   * the fallback. Both are ignored on non-retryable statuses, where a wait is pointless.
   */
  private extractRetryInfo(headers: unknown, status: number | undefined): RetryInfo {
    const info: RetryInfo = {};

    const remaining = readHeader(headers, 'x-ratelimit-remaining');
    if (remaining !== undefined && /^\d+$/.test(remaining.trim())) {
      info.rateLimitRemaining = Number.parseInt(remaining.trim(), 10);
    }

    if (status === undefined || !RETRYABLE_STATUS_CODES.includes(status)) {
      return info;
    }

    const wait =
      sanitizeWait(parseRetryAfter(readHeader(headers, 'retry-after'))) ??
      sanitizeWait(parseRateLimitReset(readHeader(headers, 'x-ratelimit-reset')));

    if (wait !== undefined) {
      info.retryAfterMs = wait;
    }

    return info;
  }

  /**
   * Recover the retry hints from an error, whichever form it has reached us in.
   *
   * Accepts a raw AxiosError (headers still attached) or the McpError that the client's
   * response interceptor has already converted it into (hints copied onto `data`).
   */
  getRetryInfo(error: unknown): RetryInfo {
    if (error instanceof McpError) {
      if (!isRecord(error.data)) {
        return {};
      }

      const info: RetryInfo = {};
      const { status, method, retryAfterMs, rateLimitRemaining } = error.data;

      if (typeof status === 'number') {
        info.status = status;
      }
      if (typeof method === 'string') {
        info.method = method;
      }
      if (typeof retryAfterMs === 'number') {
        info.retryAfterMs = retryAfterMs;
      }
      if (typeof rateLimitRemaining === 'number') {
        info.rateLimitRemaining = rateLimitRemaining;
      }

      return info;
    }

    const err = error as ErrorLike;
    if (!err.isAxiosError) {
      return {};
    }

    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const info: RetryInfo = this.extractRetryInfo(axiosError.response?.headers, status);

    if (status !== undefined) {
      info.status = status;
    }
    const method = axiosError.config?.method?.toUpperCase();
    if (method !== undefined) {
      info.method = method;
    }

    return info;
  }

  /**
   * Check if error is retryable.
   *
   * This answers a narrow question: is the *upstream condition* transient? It says
   * nothing about whether replaying the request is safe - a 500 on a POST is transient
   * but may have partially applied. That call belongs to the caller, which knows the
   * verb.
   */
  isRetryable(error: unknown): boolean {
    const status = this.getRetryInfo(error).status;
    return status !== undefined && RETRYABLE_STATUS_CODES.includes(status);
  }

  /**
   * Create a user-friendly error message
   */
  getUserFriendlyMessage(error: unknown): string {
    if (error instanceof McpError) {
      return error.message;
    }

    const err = error as ErrorLike;

    if (err.isAxiosError) {
      const status = err.response?.status;
      const mapping = this.errorMappings[status as keyof typeof this.errorMappings];
      return mapping?.message || 'An error occurred while communicating with BookStack';
    }

    return 'An unexpected error occurred';
  }
}

export default ErrorHandler;
