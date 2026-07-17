import { Buffer } from 'node:buffer';
import { readFile, realpath } from 'node:fs/promises';
import { Agent } from 'node:https';
import { basename, extname, sep } from 'node:path';
import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import type { Config } from '../config/manager';
import type {
  Attachment,
  AttachmentDetail,
  AttachmentsListParams,
  AuditLogEntry,
  AuditLogListParams,
  Book,
  BookStackAPIClient,
  Bookshelf,
  BookshelfWithBooks,
  BooksListParams,
  BookWithContents,
  Chapter,
  ChaptersListParams,
  ChapterWithPages,
  ContentPermissions,
  ContentType,
  CreateAttachmentParams,
  CreateBookParams,
  CreateChapterParams,
  CreateImageParams,
  CreatePageParams,
  CreateRoleParams,
  CreateShelfParams,
  CreateUserParams,
  ExportFormat,
  ExportResult,
  Image,
  ImageDetail,
  ImageGalleryListParams,
  ListResponse,
  Page,
  PagesListParams,
  PageWithContent,
  PaginationParams,
  RecycleBinDeleteResult,
  RecycleBinItem,
  RecycleBinRestoreResult,
  RoleCreateResult,
  RoleListItem,
  RolesListParams,
  RoleWithPermissions,
  SearchParams,
  SearchResult,
  ShelvesListParams,
  SystemInfo,
  UpdateAttachmentParams,
  UpdateBookParams,
  UpdateChapterParams,
  UpdateContentPermissionsParams,
  UpdateImageParams,
  UpdatePageParams,
  UpdateRoleParams,
  UpdateShelfParams,
  UpdateUserParams,
  UserListItem,
  UsersListParams,
  UserWithRoles,
} from '../types';
import type { ErrorHandler } from '../utils/errors';
import type { Logger } from '../utils/logger';
import {
  canonicalBaseUrl,
  describeBaseUrl,
  getSharedRateLimiter,
  type RateLimiter,
} from '../utils/rateLimit';

/** A value that can be sent as a single multipart/form-data field. */
type UploadFieldValue = string | number | Buffer;

/** Flat field map for BookStack's multipart upload endpoints. */
type UploadParams = Record<string, UploadFieldValue | undefined>;

/**
 * RETRY POLICY.
 *
 * These are hardcoded constants rather than config: the `Config` schema has no retry
 * section, and `src/config/manager.ts` is owned elsewhere. Each value is a deliberate
 * bound - the loop can never run away, and the total time added to a failing call is
 * capped at RETRY_MAX_TOTAL_WAIT_MS regardless of what the server asks for.
 */
/** Total tries for one logical call: 1 initial attempt + 3 retries. */
const RETRY_MAX_ATTEMPTS = 4;
/** First backoff step; doubles per attempt (500ms, 1s, 2s, ...). */
const RETRY_BASE_DELAY_MS = 500;
/** Ceiling for any single self-computed backoff step. */
const RETRY_MAX_DELAY_MS = 8_000;
/** Ceiling for the sum of all waits across one logical call. */
const RETRY_MAX_TOTAL_WAIT_MS = 30_000;
/** Proportion of a backoff step randomised, to de-synchronise concurrent clients. */
const RETRY_JITTER_RATIO = 0.25;

/**
 * Methods whose replay cannot create or duplicate state.
 *
 * Used ONLY to gate 5xx retries. A 5xx means the request reached BookStack and may have
 * partially applied - replaying a POST could duplicate a page - so 5xx is retried for
 * safe verbs only. A 429 is different in kind: the throttle middleware rejects the
 * request *before* the route runs, so nothing was executed and any verb may be replayed.
 */
const REPLAY_SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];

/** Export formats whose bytes are binary and must not survive as a decoded string. */
const BINARY_EXPORT_FORMATS: readonly ExportFormat[] = ['pdf'];

/**
 * Content types BookStack labels its exports with.
 *
 * BookStack answers EVERY export - markdown included - with
 * `Content-Type: application/octet-stream` (verified against 25.x), which tells a caller
 * nothing. The response header is preferred when it is specific, and this map supplies
 * the real type when it is not.
 */
const EXPORT_MIME_TYPES: Record<ExportFormat, string> = {
  html: 'text/html',
  pdf: 'application/pdf',
  plaintext: 'text/plain',
  markdown: 'text/markdown',
};

/** Extension used when the response carries no usable filename. */
const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  html: 'html',
  pdf: 'pdf',
  plaintext: 'txt',
  markdown: 'md',
};

/** Generic content types that carry no information and should not be reported as-is. */
const OPAQUE_CONTENT_TYPES: readonly string[] = ['application/octet-stream', 'binary/octet-stream'];

/**
 * The result of an export, with its encoding stated rather than implied.
 *
 * `ExportResult` (src/types.ts) declares `content: string`, which cannot by itself
 * represent PDF bytes. Rather than edit that shared file, this extends it with the two
 * fields a caller needs to use `content` correctly:
 *
 *  - `encoding` - how to turn `content` back into bytes: 'utf8' (text formats, content is
 *    the document itself) or 'base64' (binary formats, content must be base64-decoded).
 *  - `byte_length` - the true size of the decoded document, which for base64 is NOT
 *    `content.length`.
 *
 * A return type may safely narrow, so the export methods still satisfy the
 * `BookStackAPIClient` interface's `Promise<ExportResult>` contract.
 */
export interface ExportContent extends ExportResult {
  encoding: 'utf8' | 'base64';
  byte_length: number;
}

/** Pause for `ms`, used between retry attempts. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coerce an axios response body into raw bytes.
 *
 * `responseType: 'arraybuffer'` yields a Buffer under Node's adapter and an ArrayBuffer
 * under others, so every shape is handled rather than assumed.
 */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  throw new Error(`Export response body had unexpected type '${typeof data}'.`);
}

/**
 * Measure a response body for the debug log without serialising it.
 *
 * JSON.stringify() on an 879KB PDF ArrayBuffer expands to a multi-megabyte
 * `{"type":"Buffer","data":[...]}` string on every single export, purely to take its
 * `.length`. Binary bodies are measured directly instead.
 */
function responseSize(data: unknown): number {
  if (data === null || data === undefined) {
    return 0;
  }
  if (typeof data === 'string') {
    return data.length;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  try {
    return JSON.stringify(data)?.length ?? 0;
  } catch {
    return -1;
  }
}

/**
 * Name a request's query parameters without reporting them.
 *
 * `count`, `offset`, `sort` and `filter` come from this codebase's own schemas; the VALUES
 * behind them are the caller's - a filter value is a name, an email address or a search
 * term. R5-W3 found the request interceptor logging the whole object, so this is what it
 * logs instead: enough to see which parameters went out, and nothing of what was in them.
 *
 * "The names come from our schemas" is TRUE ONLY IN STRICT MODE, which is R6-W2: with
 * VALIDATION_STRICT_MODE off, validateParams() hands the caller's object back unchanged and
 * these keys become whatever the caller sent. There is no schema in scope here to check them
 * against, so the check happens in the Logger instead: `param_names` is a
 * VOCABULARY_KEY_PATTERN key, and a name this server never registered is reported as a size.
 * In strict mode every name still renders, because every name really is one of ours.
 *
 * `config.params` is typed `any` by axios, so it arrives here as `unknown` and is narrowed
 * rather than cast. Only the top level is named: axios flattens `{filter: {name}}` into
 * `filter[name]` on the wire, and this is not the place to re-derive that.
 */
function paramNames(params: unknown): string[] {
  if (typeof params !== 'object' || params === null) {
    return [];
  }
  return Object.keys(params).sort();
}

/**
 * Strip a filename down to a safe basename.
 *
 * The value originates from a response header, and callers are likely to write it to
 * disk, so any directory component is removed rather than trusted.
 */
function safeFilename(candidate: string): string | undefined {
  const trimmed = candidate.trim().replace(/^["']|["']$/g, '');
  if (trimmed.length === 0) {
    return undefined;
  }

  const name = basename(trimmed).replace(/[\\/]/g, '_');
  if (name.length === 0 || name === '.' || name === '..') {
    return undefined;
  }

  return name;
}

/**
 * Recover the filename from a `Content-Disposition` header.
 *
 * BookStack sends ONLY the RFC 5987 extended form -
 * `attachment; filename*=UTF-8''export-probe-book.pdf` (verified against 25.x) - so the
 * extended parameter is tried first. A parser that looked only for the more familiar
 * `filename="..."` would find nothing here. The plain form is still accepted as a
 * fallback for older or proxied responses.
 */
function filenameFromContentDisposition(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  // RFC 5987: filename*=<charset>'<language>'<percent-encoded-value>
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  const encoded = extended?.[1];
  if (encoded) {
    try {
      return safeFilename(decodeURIComponent(encoded.trim()));
    } catch {
      // Malformed percent-encoding: fall through to the plain form.
    }
  }

  // RFC 6266 plain form: filename="value" or filename=value
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const value = plain?.[1] ?? plain?.[2];
  return value ? safeFilename(value) : undefined;
}

/**
 * `file_path` is a server-side convenience parameter, not a BookStack field.
 * It is consumed while building the request and never forwarded upstream.
 */
const LOCAL_PATH_FIELD = 'file_path';

/**
 * Check that `target` sits inside `root`.
 *
 * Both arguments must already be realpath()-resolved (absolute, normalized, symlinks
 * expanded). The comparison appends a trailing separator so that a sibling directory
 * sharing a name prefix - `/srv/uploads-evil` against a root of `/srv/uploads` - is
 * not mistaken for a child.
 */
function isContainedIn(target: string, root: string): boolean {
  if (target === root) {
    return true;
  }
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(rootWithSep);
}

/** Resolve a path to its real location, reporting a clear error if it is unreadable. */
async function resolveRealPath(candidate: string, label: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    throw new Error(`${label} '${candidate}' does not exist or is not readable by the server.`);
  }
}

/**
 * SECURITY GUARD for the `file_path` upload parameter.
 *
 * `file_path` asks the *server process* to read a local file and upload its bytes to
 * BookStack. This server also exposes an HTTP transport (`POST /message`), where the
 * caller is remote and untrusted. An unguarded `file_path` would therefore be an
 * arbitrary-local-file-read and exfiltration primitive: a remote caller could pass
 * `/etc/passwd` or `~/.ssh/id_rsa` and have the server upload it into BookStack.
 *
 * The rules, in order:
 *
 *  1. stdio transport (`MCP_TRANSPORT=stdio`): the MCP client launched this process and
 *     shares its trust domain, so any path it could already read itself is allowed.
 *  2. Any other transport (HTTP is the default): `file_path` is refused outright unless
 *     the operator explicitly opts in by setting `BOOKSTACK_UPLOAD_ROOT`. When set, the
 *     candidate is resolved with realpath() - which also expands symlinks - and must be
 *     contained within the likewise-resolved root. This rejects `../` traversal and
 *     symlink escapes, since containment is checked after resolution, not before.
 *
 * Refusal is always explicit; `file_path` is never silently ignored.
 */
export async function readGuardedUploadFile(filePath: string): Promise<Buffer> {
  const transport = process.env.MCP_TRANSPORT ?? 'http';

  // 1. Local stdio client: same trust domain as this process.
  if (transport === 'stdio') {
    const realTarget = await resolveRealPath(filePath, 'file_path');
    return readFile(realTarget);
  }

  // 2. Remote-capable transport: require an explicit opt-in root.
  const uploadRoot = process.env.BOOKSTACK_UPLOAD_ROOT;
  if (!uploadRoot) {
    throw new Error(
      `'file_path' is refused under the '${transport}' transport because the caller may be remote, ` +
        'and reading arbitrary server-local files would leak them into BookStack. ' +
        'Set BOOKSTACK_UPLOAD_ROOT to a directory that uploads may be read from to enable it, ' +
        'or send the file content inline as base64 instead.'
    );
  }

  const realRoot = await resolveRealPath(uploadRoot, 'BOOKSTACK_UPLOAD_ROOT');
  const realTarget = await resolveRealPath(filePath, 'file_path');

  if (!isContainedIn(realTarget, realRoot)) {
    throw new Error(
      `'file_path' resolves to '${realTarget}', which is outside BOOKSTACK_UPLOAD_ROOT ` +
        `('${realRoot}'). Only files within that directory may be uploaded.`
    );
  }

  return readFile(realTarget);
}

/**
 * Sniff an image extension from magic bytes.
 *
 * BookStack validates the gallery upload against `mimes:jpeg,png,gif,webp,avif` and an
 * `image_extension` rule, so the filename extension has to match the actual bytes. When
 * the caller's `name` carries no extension, guessing from content beats a blind default.
 */
function detectImageExtension(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return '.png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  const header = bytes.subarray(0, 12).toString('latin1');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return '.gif';
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return '.webp';
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return '.avif';
  }
  return '.png';
}

/**
 * Derive the filename for the uploaded part.
 *
 * Preference order: an extension already present on `name`, then the extension of the
 * source `file_path`, then a content-sniffed image extension, then a neutral default.
 */
function uploadFilename(params: UploadParams, fileField: string, bytes: Buffer): string {
  const rawName = typeof params.name === 'string' ? params.name.trim() : '';
  // Strip any directory component so `name` can never steer the part's filename.
  const name = rawName ? basename(rawName).replace(/[\\/]/g, '_') : '';
  if (name && extname(name).length > 1) {
    return name;
  }

  const sourcePath = params[LOCAL_PATH_FIELD];
  if (typeof sourcePath === 'string') {
    const sourceName = basename(sourcePath);
    const sourceExt = extname(sourceName);
    if (sourceExt.length > 1) {
      return name ? `${name}${sourceExt}` : sourceName;
    }
  }

  const fallbackExt = fileField === 'image' ? detectImageExtension(bytes) : '.bin';
  return `${name || 'upload'}${fallbackExt}`;
}

/**
 * BookStack API Client
 *
 * Provides a comprehensive wrapper around the BookStack REST API
 * with built-in error handling, rate limiting, and retry logic.
 */
export class BookStackClient implements BookStackAPIClient {
  private client: AxiosInstance;
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private rateLimiter: RateLimiter;
  private config: Config;

  constructor(config: Config, logger: Logger, errorHandler: ErrorHandler) {
    this.config = config;
    this.logger = logger;
    this.errorHandler = errorHandler;

    // ONE canonical URL, computed ONCE, used for BOTH the bucket key below and the axios
    // baseURL further down. Those two must not be allowed to disagree: the bucket exists to
    // bound what is spent against a particular upstream, so if axios resolves
    // `HTTP://EXAMPLE.COM:80/api` and `http://example.com/api` to the same host while the
    // registry keys them as two strings, the identity gets two full buckets pointed at one
    // BookStack and the configured limit stops being a limit. Deriving both from this single
    // value makes that class of drift unrepresentable rather than merely absent today.
    //
    // It also validates: `x-bookstack-url` is caller-supplied and never passes through the
    // config schema (server.ts merges the header straight into a Partial<Config>), so this
    // is where a junk or non-http(s) URL is refused - before axios is pointed at it.
    const baseUrl = canonicalBaseUrl(config.bookstack.baseUrl);

    // NOT `new RateLimiter(...)`. This object is request-scoped under the HTTP transport -
    // one per POST /message - so a bucket owned by it would be refilled to full for every
    // RPC, and the configured limit would bound nothing. The bucket belongs to the
    // credential being spent against the upstream, so it is looked up by that identity and
    // shared with every other client spending the same one. Per-request `x-bookstack-url` /
    // `x-bookstack-token` overrides land here as a different identity, and therefore keep
    // their own budget rather than draining someone else's.
    this.rateLimiter = getSharedRateLimiter({
      baseUrl,
      apiToken: config.bookstack.apiToken,
      requestsPerMinute: config.rateLimit.requestsPerMinute,
      burstLimit: config.rateLimit.burstLimit,
    });

    // Create HTTP agent for connection pooling
    const httpsAgent = new Agent({
      keepAlive: true,
      maxSockets: 10,
      timeout: config.bookstack.timeout,
    });

    // Initialize Axios client
    this.client = axios.create({
      // The same canonical value the bucket above is keyed by - see the note there.
      baseURL: baseUrl,
      timeout: config.bookstack.timeout,
      httpsAgent,
      headers: {
        Authorization: `Token ${config.bookstack.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `${config.server.name}/${config.server.version}`,
      },
    });

    this.setupInterceptors();
    // NOT `{baseUrl}`. R6-W3: the redactor keeps a URL's path on purpose - `/books/5` is
    // what makes the request line below worth reading - and the base URL's path is the one
    // an operator supplied, which is where a reverse-proxy capability or tenant secret
    // lives. describeBaseUrl() reports the origin plus the shape of the path: which
    // BookStack, at what depth, spelled out when it is one of the documented constants and
    // digested when it is not. See its note in ../utils/rateLimit.
    this.logger.info('BookStack API client initialized', {
      ...describeBaseUrl(baseUrl),
      timeout: config.bookstack.timeout,
    });
  }

  /**
   * Setup request and response interceptors
   */
  private setupInterceptors(): void {
    // Request interceptor for rate limiting and logging
    this.client.interceptors.request.use(
      async (config) => {
        // Apply rate limiting
        await this.rateLimiter.acquire();

        this.logger.debug('API request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          // The parameter NAMES, not the parameters. R5-W3: this line recursively logged
          // the whole query object, so `{filter: {name: '<the caller's search term>'}}` was
          // written out at `debug` - the level an operator turns on precisely when
          // something is going wrong and the log is being read. Which parameters were sent
          // is the diagnostic fact; what was in them is the caller's.
          param_names: paramNames(config.params),
        });

        return config;
      },
      (error) => {
        this.logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling and logging
    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug('API response', {
          status: response.status,
          url: response.config.url,
          dataLength: responseSize(response.data),
        });
        return response;
      },
      (error: AxiosError) => {
        this.logger.error('API error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
          data: error.response?.data,
        });

        return Promise.reject(this.errorHandler.handleAxiosError(error));
      }
    );
  }

  /**
   * Decide whether a failed attempt may be replayed.
   *
   * Splits the question in two, because the two halves have different owners:
   *
   *  - Is the failure transient? -> ErrorHandler.isRetryable(), which knows the statuses.
   *  - Is replaying this verb safe? -> here, because only the caller knows the method.
   *
   * A 429 is always replayable: Laravel's throttle middleware rejects the request before
   * the route executes, so no work was done and no state changed. A 5xx is only replayed
   * for safe verbs, since the request did reach the application and a POST that timed out
   * mid-write could otherwise be duplicated.
   */
  private isReplayable(error: unknown, method: string): boolean {
    if (!this.errorHandler.isRetryable(error)) {
      return false;
    }

    const status = this.errorHandler.getRetryInfo(error).status;
    if (status === 429) {
      return true;
    }

    return REPLAY_SAFE_METHODS.includes(method);
  }

  /**
   * Compute the wait before the next attempt.
   *
   * A server-directed wait (`Retry-After`, else `X-RateLimit-Reset`) always wins - the
   * server knows when its window rolls over and guessing shorter just burns another
   * rejected request. Otherwise: exponential backoff with jitter, so that concurrent
   * clients throttled by the same window do not march back in lockstep.
   */
  private retryDelayMs(error: unknown, attempt: number): number {
    const serverDirected = this.errorHandler.getRetryInfo(error).retryAfterMs;
    if (serverDirected !== undefined) {
      // Add a small settling margin: waiting exactly Retry-After can land on the
      // boundary and be rejected again.
      return serverDirected + 250;
    }

    const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    return Math.round(exponential * (1 + Math.random() * RETRY_JITTER_RATIO));
  }

  /**
   * Perform a request, retrying transient failures within strict bounds.
   *
   * Returns the whole response, since the export path needs the headers.
   *
   * Bounds: at most RETRY_MAX_ATTEMPTS tries, at most RETRY_MAX_TOTAL_WAIT_MS spent
   * waiting in total. A wait that would breach the total budget is not taken at all -
   * the error surfaces immediately rather than after a pointless sleep.
   */
  private async requestWithRetry<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const method = (config.method ?? 'GET').toUpperCase();
    let waitedMs = 0;
    let lastError: unknown;

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        // A fresh config per attempt: axios mutates what it is handed.
        return await this.client.request<T>({ ...config });
      } catch (error) {
        lastError = error;

        if (attempt === RETRY_MAX_ATTEMPTS || !this.isReplayable(error, method)) {
          break;
        }

        const delay = this.retryDelayMs(error, attempt);
        if (waitedMs + delay > RETRY_MAX_TOTAL_WAIT_MS) {
          this.logger.debug('Retry budget exhausted; surfacing error', {
            method,
            url: config.url,
            attempt,
            waitedMs,
            requestedDelayMs: delay,
            maxTotalWaitMs: RETRY_MAX_TOTAL_WAIT_MS,
          });
          break;
        }

        const info = this.errorHandler.getRetryInfo(error);
        this.logger.debug('Retrying request after transient failure', {
          method,
          url: config.url,
          status: info.status,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          delayMs: delay,
          serverDirected: info.retryAfterMs !== undefined,
          rateLimitRemaining: info.rateLimitRemaining,
        });

        await sleep(delay);
        waitedMs += delay;
      }
    }

    throw this.errorHandler.handleError(lastError);
  }

  /**
   * Generic request method with retry logic
   */
  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    const response = await this.requestWithRetry<T>(config);
    return response.data;
  }

  /**
   * Fetch an export and package it as a truthful ExportResult.
   *
   * Two things this has to get right:
   *
   *  1. BookStack returns the raw file body, NOT a JSON envelope. The old code declared
   *     Promise<ExportResult> but simply handed back the parsed body, so every caller
   *     reading `.content` got undefined.
   *  2. Every format is fetched as an arraybuffer. For PDF this is essential - decoding
   *     879KB of binary as UTF-8 replaces every invalid sequence with U+FFFD and corrupts
   *     the file irreversibly. Text formats are then decoded from those exact bytes, so
   *     the byte count always matches Content-Length.
   */
  private async fetchExport(
    resource: 'books' | 'chapters' | 'pages',
    id: number,
    format: ExportFormat
  ): Promise<ExportContent> {
    const response = await this.requestWithRetry<unknown>({
      method: 'GET',
      url: `/${resource}/${id}/export/${format}`,
      responseType: 'arraybuffer',
      // The instance default is `application/json`; exports are anything but.
      headers: { Accept: '*/*' },
    });

    const bytes = toBuffer(response.data);
    const isBinary = BINARY_EXPORT_FORMATS.includes(format);

    const contentType = response.headers['content-type'];
    const declaredType =
      typeof contentType === 'string' ? contentType.split(';')[0]?.trim().toLowerCase() : undefined;
    // Prefer what the server declared, but only when it actually said something.
    const mimeType =
      declaredType && !OPAQUE_CONTENT_TYPES.includes(declaredType)
        ? declaredType
        : EXPORT_MIME_TYPES[format];

    const disposition = response.headers['content-disposition'];
    const filename =
      filenameFromContentDisposition(typeof disposition === 'string' ? disposition : undefined) ??
      `${resource.slice(0, -1)}-${id}.${EXPORT_EXTENSIONS[format]}`;

    // `filename` is deliberately absent: BookStack derives it from the entity's NAME, so
    // `content-disposition` hands back the caller's text with a file extension on it. The
    // size, format and declared type are the operational facts, and the id is what ties the
    // line to the entity without quoting it.
    this.logger.debug('Export fetched', {
      resource,
      id,
      format,
      mimeType,
      bytes: bytes.length,
      encoding: isBinary ? 'base64' : 'utf8',
    });

    return {
      content: isBinary ? bytes.toString('base64') : bytes.toString('utf8'),
      filename,
      mime_type: mimeType,
      encoding: isBinary ? 'base64' : 'utf8',
      byte_length: bytes.length,
    };
  }

  /**
   * Upload via multipart/form-data.
   *
   * BookStack's image-gallery and attachment endpoints take the payload as a file part
   * and reject a JSON body, so these four routes bypass the JSON `request()` path.
   *
   * Two details make this work:
   *
   *  - The instance-level `Content-Type: application/json` default MUST be cleared for
   *    this request. Axios's `transformRequest` inspects the declared content type and
   *    silently converts a FormData payload to JSON when it still says `application/json`
   *    (`hasJSONContentType ? JSON.stringify(formDataToJSON(data)) : data`). Sending
   *    `null` deletes the header, which both avoids that conversion and lets the http
   *    adapter stream the form and set `multipart/form-data` with its own generated
   *    boundary. Hand-setting `multipart/form-data` here would produce a body with no
   *    boundary, which is the classic form of this bug.
   *  - PHP only populates form data for POST bodies, so BookStack documents multipart
   *    PUT as a POST carrying a `_method=PUT` override field. A literal multipart PUT
   *    parses as an empty request upstream.
   *    See https://demo.bookstackapp.com/api/docs -> Getting Started -> Request Format.
   */
  private async uploadFile<T>(
    method: 'POST' | 'PUT',
    url: string,
    params: UploadParams,
    fileField: string
  ): Promise<T> {
    const form = new FormData();

    // Laravel method override: multipart updates must travel as a POST.
    if (method === 'PUT') {
      form.append('_method', 'PUT');
    }

    const rawFile = params[fileField];
    const bytes = Buffer.isBuffer(rawFile)
      ? rawFile
      : typeof rawFile === 'string'
        ? Buffer.from(rawFile, 'base64')
        : undefined;

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || key === LOCAL_PATH_FIELD) {
        continue;
      }
      if (key === fileField) {
        if (bytes) {
          // Base64 is decoded to raw binary; BookStack expects real file bytes.
          form.append(key, new Blob([new Uint8Array(bytes)]), uploadFilename(params, key, bytes));
        }
        continue;
      }
      form.append(key, String(value));
    }

    this.logger.debug('Uploading multipart request', {
      method,
      url,
      fileField,
      bytes: bytes?.length ?? 0,
    });

    return this.request<T>({
      method: 'POST',
      url,
      data: form,
      headers: { 'Content-Type': null },
    });
  }

  /**
   * Resolve a `file_path` field into binary content for `fileField`.
   *
   * Delegates the path check to readGuardedUploadFile(); see that function for the
   * transport-dependent security rules.
   */
  private async resolveLocalFile(fields: UploadParams, fileField: string): Promise<void> {
    const filePath = fields[LOCAL_PATH_FIELD];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return;
    }

    const inline = fields[fileField];
    if (typeof inline === 'string' && inline.length > 0) {
      throw new Error(`Provide either '${fileField}' or 'file_path', not both.`);
    }

    const bytes = await readGuardedUploadFile(filePath);
    fields[fileField] = bytes;
    this.logger.debug('Read local file for upload', { fileField, bytes: bytes.length });
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getSystemInfo();
      return true;
    } catch (error) {
      this.logger.warn('Health check failed', error);
      return false;
    }
  }

  // Books API
  async listBooks(params?: BooksListParams): Promise<ListResponse<Book>> {
    return this.request<ListResponse<Book>>({
      method: 'GET',
      url: '/books',
      params,
    });
  }

  async createBook(params: CreateBookParams): Promise<Book> {
    return this.request<Book>({
      method: 'POST',
      url: '/books',
      data: params,
    });
  }

  async getBook(id: number): Promise<BookWithContents> {
    return this.request<BookWithContents>({
      method: 'GET',
      url: `/books/${id}`,
    });
  }

  async updateBook(id: number, params: UpdateBookParams): Promise<Book> {
    return this.request<Book>({
      method: 'PUT',
      url: `/books/${id}`,
      data: params,
    });
  }

  async deleteBook(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/books/${id}`,
    });
  }

  async exportBook(id: number, format: ExportFormat): Promise<ExportContent> {
    return this.fetchExport('books', id, format);
  }

  // Pages API
  async listPages(params?: PagesListParams): Promise<ListResponse<Page>> {
    return this.request<ListResponse<Page>>({
      method: 'GET',
      url: '/pages',
      params,
    });
  }

  async createPage(params: CreatePageParams): Promise<Page> {
    return this.request<Page>({
      method: 'POST',
      url: '/pages',
      data: params,
    });
  }

  async getPage(id: number): Promise<PageWithContent> {
    return this.request<PageWithContent>({
      method: 'GET',
      url: `/pages/${id}`,
    });
  }

  async updatePage(id: number, params: UpdatePageParams): Promise<Page> {
    return this.request<Page>({
      method: 'PUT',
      url: `/pages/${id}`,
      data: params,
    });
  }

  async deletePage(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/pages/${id}`,
    });
  }

  async exportPage(id: number, format: ExportFormat): Promise<ExportContent> {
    return this.fetchExport('pages', id, format);
  }

  // Chapters API
  async listChapters(params?: ChaptersListParams): Promise<ListResponse<Chapter>> {
    return this.request<ListResponse<Chapter>>({
      method: 'GET',
      url: '/chapters',
      params,
    });
  }

  async createChapter(params: CreateChapterParams): Promise<Chapter> {
    return this.request<Chapter>({
      method: 'POST',
      url: '/chapters',
      data: params,
    });
  }

  async getChapter(id: number): Promise<ChapterWithPages> {
    return this.request<ChapterWithPages>({
      method: 'GET',
      url: `/chapters/${id}`,
    });
  }

  async updateChapter(id: number, params: UpdateChapterParams): Promise<Chapter> {
    return this.request<Chapter>({
      method: 'PUT',
      url: `/chapters/${id}`,
      data: params,
    });
  }

  async deleteChapter(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/chapters/${id}`,
    });
  }

  async exportChapter(id: number, format: ExportFormat): Promise<ExportContent> {
    return this.fetchExport('chapters', id, format);
  }

  // Shelves API
  async listShelves(params?: ShelvesListParams): Promise<ListResponse<Bookshelf>> {
    return this.request<ListResponse<Bookshelf>>({
      method: 'GET',
      url: '/shelves',
      params,
    });
  }

  async createShelf(params: CreateShelfParams): Promise<Bookshelf> {
    return this.request<Bookshelf>({
      method: 'POST',
      url: '/shelves',
      data: params,
    });
  }

  async getShelf(id: number): Promise<BookshelfWithBooks> {
    return this.request<BookshelfWithBooks>({
      method: 'GET',
      url: `/shelves/${id}`,
    });
  }

  async updateShelf(id: number, params: UpdateShelfParams): Promise<Bookshelf> {
    return this.request<Bookshelf>({
      method: 'PUT',
      url: `/shelves/${id}`,
      data: params,
    });
  }

  async deleteShelf(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/shelves/${id}`,
    });
  }

  // Users API
  async listUsers(params?: UsersListParams): Promise<ListResponse<UserListItem>> {
    return this.request<ListResponse<UserListItem>>({
      method: 'GET',
      url: '/users',
      params,
    });
  }

  async createUser(params: CreateUserParams): Promise<UserWithRoles> {
    return this.request<UserWithRoles>({
      method: 'POST',
      url: '/users',
      data: params,
    });
  }

  async getUser(id: number): Promise<UserWithRoles> {
    return this.request<UserWithRoles>({
      method: 'GET',
      url: `/users/${id}`,
    });
  }

  async updateUser(id: number, params: UpdateUserParams): Promise<UserWithRoles> {
    return this.request<UserWithRoles>({
      method: 'PUT',
      url: `/users/${id}`,
      data: params,
    });
  }

  async deleteUser(id: number, migrateOwnershipId?: number): Promise<void> {
    const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
    await this.request<void>({
      method: 'DELETE',
      url: `/users/${id}`,
      data,
    });
  }

  // Roles API
  async listRoles(params?: RolesListParams): Promise<ListResponse<RoleListItem>> {
    return this.request<ListResponse<RoleListItem>>({
      method: 'GET',
      url: '/roles',
      params,
    });
  }

  async createRole(params: CreateRoleParams): Promise<RoleCreateResult> {
    return this.request<RoleCreateResult>({
      method: 'POST',
      url: '/roles',
      data: params,
    });
  }

  async getRole(id: number): Promise<RoleWithPermissions> {
    return this.request<RoleWithPermissions>({
      method: 'GET',
      url: `/roles/${id}`,
    });
  }

  async updateRole(id: number, params: UpdateRoleParams): Promise<RoleWithPermissions> {
    return this.request<RoleWithPermissions>({
      method: 'PUT',
      url: `/roles/${id}`,
      data: params,
    });
  }

  /**
   * Takes an id and sends no body.
   *
   * `RoleApiController::delete(string $id)` declares no `Request` parameter, so BookStack
   * has nowhere to read a migration target from - a role delete only strips the role from
   * its users. This once accepted a `migrateOwnershipId` and sent it as a DELETE body,
   * which upstream simply discarded while the tool implied the content was being moved.
   * The genuine article lives on `deleteUser()`.
   */
  async deleteRole(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/roles/${id}`,
    });
  }

  // Attachments API
  async listAttachments(params?: AttachmentsListParams): Promise<ListResponse<Attachment>> {
    return this.request<ListResponse<Attachment>>({
      method: 'GET',
      url: '/attachments',
      params,
    });
  }

  async createAttachment(params: CreateAttachmentParams): Promise<Attachment> {
    const fields: UploadParams = {
      uploaded_to: params.uploaded_to,
      name: params.name,
      file: params.file,
      file_path: params.file_path,
      link: params.link,
    };
    await this.resolveLocalFile(fields, 'file');

    // Link-only attachments carry no file part, so the JSON path still applies.
    if (fields.file === undefined) {
      return this.request<Attachment>({
        method: 'POST',
        url: '/attachments',
        data: { uploaded_to: params.uploaded_to, name: params.name, link: params.link },
      });
    }

    return this.uploadFile<Attachment>('POST', '/attachments', fields, 'file');
  }

  async getAttachment(id: number): Promise<AttachmentDetail> {
    return this.request<AttachmentDetail>({
      method: 'GET',
      url: `/attachments/${id}`,
    });
  }

  async updateAttachment(id: number, params: UpdateAttachmentParams): Promise<Attachment> {
    const fields: UploadParams = {
      uploaded_to: params.uploaded_to,
      name: params.name,
      file: params.file,
      file_path: params.file_path,
      link: params.link,
    };
    await this.resolveLocalFile(fields, 'file');

    // Metadata- or link-only updates carry no file part, so the JSON path still applies.
    if (fields.file === undefined) {
      return this.request<Attachment>({
        method: 'PUT',
        url: `/attachments/${id}`,
        data: { uploaded_to: params.uploaded_to, name: params.name, link: params.link },
      });
    }

    return this.uploadFile<Attachment>('PUT', `/attachments/${id}`, fields, 'file');
  }

  async deleteAttachment(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/attachments/${id}`,
    });
  }

  // Images API
  async listImages(params?: ImageGalleryListParams): Promise<ListResponse<Image>> {
    return this.request<ListResponse<Image>>({
      method: 'GET',
      url: '/image-gallery',
      params,
    });
  }

  /**
   * `name` is optional, as it is upstream: when omitted, `uploadFile()` derives the
   * part's filename from `file_path` or the content's magic bytes, and BookStack names
   * the image after it.
   */
  async createImage(params: CreateImageParams): Promise<ImageDetail> {
    // BookStack requires `image` as a file part here, so this route is always multipart.
    const fields: UploadParams = {
      name: params.name,
      type: params.type ?? 'gallery',
      uploaded_to: params.uploaded_to,
      image: params.image,
      file_path: params.file_path,
    };
    await this.resolveLocalFile(fields, 'image');

    return this.uploadFile<ImageDetail>('POST', '/image-gallery', fields, 'image');
  }

  async getImage(id: number): Promise<ImageDetail> {
    return this.request<ImageDetail>({
      method: 'GET',
      url: `/image-gallery/${id}`,
    });
  }

  async updateImage(id: number, params: UpdateImageParams): Promise<ImageDetail> {
    const fields: UploadParams = {
      name: params.name,
      image: params.image,
      file_path: params.file_path,
    };
    await this.resolveLocalFile(fields, 'image');

    // Rename-only updates carry no file part, so the JSON path still applies.
    if (fields.image === undefined) {
      return this.request<ImageDetail>({
        method: 'PUT',
        url: `/image-gallery/${id}`,
        data: { name: params.name },
      });
    }

    return this.uploadFile<ImageDetail>('PUT', `/image-gallery/${id}`, fields, 'image');
  }

  async deleteImage(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/image-gallery/${id}`,
    });
  }

  // Search API
  async search(params: SearchParams): Promise<ListResponse<SearchResult>> {
    return this.request<ListResponse<SearchResult>>({
      method: 'GET',
      url: '/search',
      params,
    });
  }

  // Recycle Bin API
  async listRecycleBin(params?: PaginationParams): Promise<ListResponse<RecycleBinItem>> {
    return this.request<ListResponse<RecycleBinItem>>({
      method: 'GET',
      url: '/recycle-bin',
      params,
    });
  }

  async restoreFromRecycleBin(deletionId: number): Promise<RecycleBinRestoreResult> {
    return this.request<RecycleBinRestoreResult>({
      method: 'PUT',
      url: `/recycle-bin/${deletionId}`,
    });
  }

  async permanentlyDelete(deletionId: number): Promise<RecycleBinDeleteResult> {
    return this.request<RecycleBinDeleteResult>({
      method: 'DELETE',
      url: `/recycle-bin/${deletionId}`,
    });
  }

  // Content Permissions API
  async getContentPermissions(
    contentType: ContentType,
    contentId: number
  ): Promise<ContentPermissions> {
    return this.request<ContentPermissions>({
      method: 'GET',
      url: `/content-permissions/${contentType}/${contentId}`,
    });
  }

  async updateContentPermissions(
    contentType: ContentType,
    contentId: number,
    params: UpdateContentPermissionsParams
  ): Promise<ContentPermissions> {
    return this.request<ContentPermissions>({
      method: 'PUT',
      url: `/content-permissions/${contentType}/${contentId}`,
      data: params,
    });
  }

  // Audit Log API
  async listAuditLog(params?: AuditLogListParams): Promise<ListResponse<AuditLogEntry>> {
    return this.request<ListResponse<AuditLogEntry>>({
      method: 'GET',
      url: '/audit-log',
      params,
    });
  }

  // System API
  async getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>({
      method: 'GET',
      url: '/system',
    });
  }
}

export default BookStackClient;
