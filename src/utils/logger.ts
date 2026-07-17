import { Buffer } from 'node:buffer';
import winston, { type Logger as WinstonLogger } from 'winston';

/** Severity threshold. Mirrors `Config['logging']['level']`. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/** Output shape. Mirrors `Config['logging']['format']`. */
export type LogFormat = 'json' | 'pretty';

/**
 * Logger settings — structurally identical to `Config['logging']`.
 *
 * Declared here rather than imported from ../config/manager on purpose: the
 * logger is a leaf that every other module (ConfigManager included) depends on,
 * so it must not depend on the config module in turn. ConfigManager passes its
 * validated `config.logging` straight into `configure()`, and the compiler
 * checks the two shapes still line up at that call site.
 */
export interface LoggingOptions {
  level: LogLevel;
  format: LogFormat;
}

/**
 * Settings used until `configure()` receives the validated config.
 *
 * These are plain fallbacks, deliberately *not* a second reading of
 * LOG_LEVEL / LOG_FORMAT. Those env vars are mapped to config in exactly one
 * place — ConfigManager.loadConfig(), which then calls `configure()` — so there
 * is a single source of truth. Only lines logged before the config loads fall
 * back to these, which in practice means none: ConfigManager loads the config
 * in its own constructor, immediately after taking this singleton.
 */
const DEFAULT_OPTIONS: LoggingOptions = { level: 'info', format: 'pretty' };

/**
 * Route every level to stderr.
 *
 * Load-bearing for the stdio transport: stdout carries the MCP JSON-RPC stream,
 * so a log line written there corrupts the protocol mid-session. Winston's
 * Console transport sends anything below `error` to stdout by default, hence
 * this explicit list. Both formats share it — see createWinstonLogger().
 */
const STDERR_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

/**
 * REDACTION: WHY EVERY LOG LINE GOES THROUGH IT.
 *
 * The `tools/call` handler used to log `{arguments: args}` at `info` - the default level -
 * which meant a `bookstack_users_create` wrote the new account's plaintext password into
 * the log, a page create wrote the whole document body, and an image or attachment upload
 * duplicated its entire base64 payload (up to the 70 MiB body ceiling) into container
 * logs. That call site no longer logs arguments at all.
 *
 * This is the second line of defence, and it lives in the Logger rather than at the call
 * sites on purpose: every tool, resource and client module funnels through these four
 * methods, so a redaction rule here holds for log lines nobody has written yet. Anything
 * enforced per-call-site would only hold until the next `logger.info('...', params)`.
 *
 * WHY A BLOCKLIST OF KEY NAMES IS NOT ENOUGH.
 *
 * The first version of this redacted by property NAME only, which left three holes that a
 * probe walked straight through:
 *
 *  - `baseUrl` is logged at `info` by the API client and is not a "sensitive key", so
 *    `https://alice:hunter2@bookstack/api?api_token=...` went to the log intact. A URL
 *    carries its credentials INSIDE the value, where no key rule can see them. Hence
 *    sanitizeUrlRun(): a URL is rewritten STRUCTURALLY - userinfo dropped, sensitive
 *    query values replaced - wherever one appears, including inside prose.
 *  - `Error` objects were handed to Winston untouched, on the theory that error text is
 *    written by this codebase rather than by callers. The upload path disproves it: the
 *    `file_path` guard interpolates the caller's path, the resolved target and the upload
 *    root into its message, and axios errors carry the upstream body. So an Error is now
 *    reduced to a chosen set of STABLE fields (see toSafeError) instead of being exempt.
 *  - The second version named the payload keys it knew about (`html`, `file`, `password`,
 *    ...) and let every other string through. R5-W3 walked in through the keys nobody had
 *    thought to name: `bookstack_search` logged the caller's whole `query` at `info`,
 *    `bookstack_users_create` logged `name` and `email`, and the axios debug line logged
 *    the query `params`, filter values and all. A blocklist is a list of the leaks
 *    somebody has already found.
 *
 * SO THE RULE IS AN ALLOWLIST: A STRING IS WITHHELD UNLESS ITS KEY PROVES IT SAFE.
 *
 * A value's TYPE and SIZE are operational facts worth logging; free text is the caller's
 * until proven otherwise, and the proof has to be positive. Applied to every meta value at
 * every level:
 *  1. A key that names a credential -> the value never appears, not even its length.
 *  2. An Error, under any key -> its stable identity (name/code/status/frames); its
 *     message is prose, so only its length survives.
 *  3. `stack` -> its FRAMES, which are code locations rather than prose.
 *  4. A key that names error prose (`error`, `message`, `data`, ...) -> replaced by its
 *     size, whatever its type: an upstream body is an object, and recursing into it would
 *     print whichever of its leaves happened to be named something innocuous.
 *  5. A string under a key on SAFE_STRING_KEY_PATTERN -> URL-sanitized, escaped and
 *     capped. That list is short, closed, and every entry names the call site that writes
 *     it.
 *  6. A string under a key on VOCABULARY_KEY_PATTERN -> rendered ONLY if this process
 *     registered it as one of its own names, and sized otherwise. R6-W2: `tool` and
 *     `argument_names` were on the allowlist because a tool name and an argument name
 *     "come from our schemas" - but the line that wrote them ran before the tool was
 *     looked up, and in non-strict mode `Object.keys(validatedParams)` is the caller's
 *     object. The claim was right about where those names USUALLY come from and wrong
 *     about where they CAN come from, so it is now checked rather than believed.
 *  7. EVERY OTHER STRING -> its size. `query`, `name`, `email`, `display_name`,
 *     `filename`, a filter value, a string this codebase does not log yet: all the same,
 *     because the default is what decides whether the NEXT call site leaks.
 *  8. Numbers, booleans and binary sizes survive: they carry no prose, and they are
 *     frequently the whole point of the line (`status: 422`, `bytes: 51200`).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not try to tell a caller's text from the
 * codebase's own by inspecting the text. It cannot, so it does not guess - which is why
 * stable, machine-readable context (status codes, error names, HTTP methods, frame lists)
 * is preserved carefully: that context is what makes a log line useful once the prose is
 * gone. A redactor that blanks everything is not a fix either; the surviving-context half
 * of tests/unit/log-redaction.test.ts is what says so.
 *
 * THE CALL SITES STILL MATTER. This is the backstop, not the plan: a handler that logs
 * `{query_length: n}` says something an operator can use, while one that logs `{query}` now
 * says `[redacted: 37 chars]` - correct, and useless. Log facts, and let this catch what
 * the next person forgets.
 */

/**
 * Keys whose value is a credential. Substring-matched, case-insensitively, so
 * `password`, `apiToken`, `api_key` and `Authorization` are all caught.
 * Deliberately does NOT match `external_auth_id`, which is an identity mapping rather
 * than a secret.
 *
 * This rule is still a blocklist, and deliberately so: it is STRONGER than the default,
 * not weaker. A key it does not match is withheld anyway; what matching adds is that not
 * even the LENGTH is reported, because the length of a secret is information about the
 * secret.
 *
 * Also applied to URL QUERY PARAMETER names by renderSanitizedUrl().
 */
const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|authorization|credential|api[-_]?key|cookie/i;

/**
 * The only keys whose STRING value is rendered rather than reduced to its size.
 *
 * WHAT QUALIFIES: a value this codebase writes, drawn from a fixed vocabulary - an HTTP
 * verb, an enum label, or a URL (which is then taken apart structurally). What does NOT
 * qualify is anything a caller composes: a name, a search query, an email, a filter value,
 * a filename derived from an entity's name. When in doubt the answer is to leave it off,
 * because a size still tells an operator that the field was there and roughly how big it
 * was.
 *
 * WHAT USED TO BE ON THIS LIST AND IS NOT ANY MORE.
 *
 * `tool`, `argument_names`, `fields`, `filters` and `param_names` were here on the reasoning
 * that a KEY NAME comes out of a schema rather than out of a caller. R6-W2 disproved both
 * halves of that. `tool`/`argument_names` were written by src/server.ts BEFORE the tool was
 * looked up or its arguments validated, so at that moment both were whatever arrived over
 * the wire. `fields`/`filters`/`param_names` are only schema vocabulary while STRICT
 * validation is on: in the documented non-strict mode validateParams() hands the caller's
 * own object straight back, so `Object.keys()` of it is the caller's text. Those five keys
 * now go through VOCABULARY_KEY_PATTERN, which CHECKS the claim instead of taking it.
 *
 * `baseUrl`/`base_url` are gone for R6-W3's reason. A URL is rendered with its PATH intact -
 * that is what makes a request line diagnostic - but a BASE url's path is arbitrary
 * operator-supplied text, and a reverse-proxy capability or tenant secret sits in exactly
 * that position. No call site logs a base URL any more (src/api/client.ts and src/server.ts
 * log describeBaseUrl()'s origin, segment count and digest instead), so the key comes off
 * the list to stop the next call site from quietly reintroducing the leak.
 *
 * Every entry names the call site that writes it, and the whole-key `^...$` match is what
 * stops `type` from also blessing a `type_of_secret` somebody adds later:
 *  - `method`, `url` - src/api/client.ts and src/utils/errors.ts. `url` is the request path
 *    this client built from its own route constants. URL-sanitized like any other string:
 *    being on this list means "may be rendered", not "is exempt".
 *  - `base_origin`, `base_path`, `base_path_digest` - describeBaseUrl() in
 *    ../utils/rateLimit, which is the ONLY thing that renders a base URL now. An origin
 *    holds no path; `base_path` is only ever one of that function's known constants; a
 *    digest is hex.
 *  - `type`, `content_type` - enum labels: an error mapping's 'validation_error', an
 *    image's 'gallery'/'drawio', a permission target's 'book'/'page'.
 *  - `format`, `encoding`, `mimeType`/`mime_type` - the export path's own vocabulary, plus
 *    the Content-Type upstream declared.
 *  - `source` - 'file_path' | 'base64' | 'link', chosen by the upload builder.
 *  - `sort` - a listing's sort, checked against an enum before it is logged.
 *  - `fileField` - 'file' | 'image', a constant in the multipart builder.
 *  - `schema`, `issue_codes` - src/validation/validator.ts's non-strict warning. `schema` is
 *    the name of one of OUR schemas, and the lookup that precedes the log line is what
 *    proves it (an unknown name throws before it can be logged). `issue_codes` are mapped
 *    onto a frozen list of Zod's own issue codes there, so an unrecognised one arrives here
 *    as 'other' rather than as text.
 *  - `config_errors` - src/config/manager.ts's startup validation failure. These are OUR
 *    schema's messages naming the offending variable, not its value: the schema text is a
 *    constant, and the messages that could have quoted a credential (a bad base URL) are
 *    canonicalBaseUrl()'s, which name the setting and the offending COMPONENT and
 *    interpolate nothing at all. Without this the operator is told only
 *    "[redacted: N chars]" at exactly the moment they need to know which variable is wrong.
 */
const SAFE_STRING_KEY_PATTERN =
  /^(method|url|base_origin|base_path|base_path_digest|type|content_type|format|encoding|mimeType|mime_type|source|sort|fileField|schema|issue_codes|config_errors)$/i;

/**
 * Keys whose value is a NAME this server is claimed to have defined - and which is checked
 * against the names it actually defined before any of it is rendered.
 *
 * WHY A CHECK RATHER THAN A PROMISE. These keys carry identifiers: a tool's name, the names
 * of the arguments it was called with, the key names of a filter, a resource's URI template.
 * All of them are worth logging - "which tool, called with which arguments, failed" is most
 * of what a tool-boundary line is for - and all of them are read out of an object that a
 * caller supplied. The old rule was that `Object.keys()` of a validated object can only
 * contain schema names. That is true only when strict validation is on, and it was never
 * true at src/server.ts's tools/call line, which logged the name before looking it up. So
 * the rule is now the one thing that holds either way: a name is rendered IF AND ONLY IF
 * this process registered it.
 *
 * WHAT THE REGISTRY CONTAINS: every registered tool name, every property name reachable in
 * any registered tool's inputSchema (recursively, so a filter's `email` counts), and every
 * registered resource URI template. That is a closed set of a few hundred strings that this
 * codebase wrote and publishes to every client through tools/list - so a caller who gets
 * one of them rendered has learned nothing that was not already public, and a caller who
 * sends anything else gets a size.
 *
 * WHAT IT DOES NOT DO: vouch for VALUES. Only names go under these keys; the values behind
 * them are the caller's secrets and content, and no rule here would render them.
 */
const VOCABULARY_KEY_PATTERN = /^(tool|resource|argument_names|fields|filters|param_names)$/i;

/**
 * The names this process registered. Empty until src/server.ts fills it in, which is the
 * safe direction: before anything is registered, every name is withheld.
 */
const registeredSafeNames = new Set<string>();

/**
 * Declare names as this server's own vocabulary, so a log line may render them.
 *
 * Additive and idempotent: src/server.ts calls it once per BookStackMCPServer, and the HTTP
 * transport builds one of those per request. Union of a fixed set with itself, a few hundred
 * strings.
 */
export function registerSafeNames(names: Iterable<string>): void {
  for (const name of names) {
    registeredSafeNames.add(name);
  }
}

/** Whether `name` is one this process registered. Exported for the redaction tests. */
export function isRegisteredSafeName(name: string): boolean {
  return registeredSafeNames.has(name);
}

/**
 * Keys whose value is error prose rather than a fact about the request.
 *
 * These are the keys R4-W3 found leaking. `src/server.ts` logs `{error: message, stack}`
 * at the tool boundary and `src/api/client.ts` logs `{message: error.message, data:
 * error.response?.data}`, and none of those names looks like a credential - so an upload
 * error carrying the caller's `file_path`, or a 422 body quoting the content that was
 * rejected, was written out verbatim.
 *
 * Whole-key matches: `data` is opaque, `dataLength` is a number worth keeping. The size
 * still goes to the log, and the SIBLING keys on those same lines - `status`, `url`,
 * `method`, `attempt` - are untouched, which is what keeps the line diagnostic.
 */
const FREE_TEXT_KEY_PATTERN =
  /^(error|errors|message|msg|reason|detail|details|data|body|response|cause)$/i;

/** Keys whose value is a stack string; handled by safeStack() rather than dropped. */
const STACK_KEY_PATTERN = /^(stack|stacktrace|stack_trace)$/i;

/** Longest string rendered into a log line. Generous enough to keep a stack trace useful. */
const MAX_STRING_LENGTH = 2048;
/** Longest array rendered. */
const MAX_ARRAY_LENGTH = 50;
/** Deepest object rendered. */
const MAX_DEPTH = 8;

/** Cap a string, saying how much was dropped rather than dropping it silently. */
function capString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_LENGTH)}… [+${value.length - MAX_STRING_LENGTH} chars]`;
}

/** Say how big something was, without saying what it was. */
function redactedSize(value: string): string {
  return `[redacted: ${value.length} chars]`;
}

/**
 * A run of text that begins like a URL: a scheme, an authority, and everything up to the
 * next whitespace.
 *
 * IT STOPS AT WHITESPACE AND NOTHING ELSE, which is the R5-W3 fix. The previous pattern
 * also stopped at the characters that usually DELIMIT a URL in prose - quotes, parens,
 * braces - on the theory that they could not belong to the URL itself. They can:
 *
 *     new URL("https://alice:pw)marker@example.com/api").password === "pw)marker"
 *     new URL("https://alice:pw'marker@example.com/api").password === "pw'marker"
 *
 * Both are URLs by WHATWG's rules and Bun parses them, but the pattern truncated each match
 * at the delimiter, leaving `https://alice:pw` - which is NOT a URL (`pw` is not a port), so
 * parsing failed and the ORIGINAL string, credential and all, was handed back unredacted.
 * Truncating before sanitizing is what made the delimiter list a hole: every character it
 * excluded was a character a password could contain.
 *
 * So the run is taken whole and the parser decides. Prose delimiters are dealt with AFTER a
 * parse fails (see sanitizeUrlRun), never before, and over-capturing a closing quote into a
 * path is a cosmetic cost paid to a rule that cannot leak.
 */
const URL_RUN_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** What a run that looks like a URL but cannot be parsed is replaced with. */
const UNPARSABLE_URL = '[redacted: unparsable URL]';

/** Parse `raw` as a URL, or say it is not one. */
function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * Rewrite one parsed URL so it can be logged.
 *
 * STRUCTURAL, not textual: the URL is reassembled from the parts the parser found, so what
 * survives is a decision about each part rather than a pattern match over the whole.
 *  - userinfo (`user:pass@`) is dropped entirely, and its former presence is recorded -
 *    an operator debugging auth needs to know the URL carries credentials, and needs the
 *    credentials themselves not to be in the log.
 *  - query values whose NAME looks like a credential (`?api_token=`) are replaced.
 *  - scheme, host, port and path are kept: they are what makes the line diagnostic.
 *
 * Re-encoding through URLSearchParams is load-bearing beyond tidiness: it percent-encodes
 * every remaining value, so a newline smuggled through a query string cannot forge a log
 * line. The marker is bare `REDACTED` rather than `[redacted]` because the brackets would
 * come back out as `%5Bredacted%5D`.
 */
function renderSanitizedUrl(url: URL): string {
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (SECRET_KEY_PATTERN.test(key)) {
      params.set(key, 'REDACTED');
    }
  }

  const query = params.toString();
  const search = query.length > 0 ? `?${query}` : '';
  const credentials = url.username || url.password ? '[redacted]@' : '';
  // The fragment goes wholesale: nothing in this codebase logs one, and a fragment is
  // where an implicit-flow access token would sit if a URL ever arrived carrying one.
  const hash = url.hash.length > 0 ? '#REDACTED' : '';

  return `${url.protocol}//${credentials}${url.host}${url.pathname}${search}${hash}`;
}

/**
 * Split a run into the URL and the prose that came along with it.
 *
 * ONLY REACHED WHEN THE RUN AS IT STANDS IS NOT A URL - `https://host:8080'`, where the
 * quote makes the port unparsable. `at https://host/api.` ends a sentence and
 * `see [https://host/api]` is a bracketed link, but the parser accepts both delimiters into
 * the path, so those two never get here and keep their punctuation without this having to
 * guess. A `]` is only given back when the run holds no `[` to match it - otherwise it is
 * an IPv6 authority, where the bracket is part of the address.
 */
function trimUrlDelimiters(match: string): { url: string; trailing: string } {
  let url = match;
  let trailing = '';

  for (;;) {
    const last = url.at(-1);
    if (last === undefined) {
      break;
    }
    const isSentencePunctuation = /[.,;:!?]/.test(last);
    const isProseBracket = last === ']' && !url.includes('[');
    if (!isSentencePunctuation && !isProseBracket) {
      break;
    }
    trailing = `${last}${trailing}`;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}

/**
 * Rewrite one URL-shaped run, in the one order that cannot leak.
 *
 *  1. Parse the run EXACTLY as it appeared. A URL may legally hold quotes, parens, braces
 *     and backticks in its userinfo and query, so this is the only step that sees the
 *     credential in `https://alice:pw)marker@host/api` at all. R5-W3 is the proof: guessing
 *     at prose first truncated the run to something unparsable, and the fallback printed
 *     the original.
 *  2. Only if that fails, strip trailing prose punctuation and parse again - the
 *     `https://host:8080'` case, where the quote is genuinely not part of the URL.
 *  3. If neither shape parses, the run is URL-shaped text this module cannot take apart -
 *     `https://alice:pw@host:99999999/api` (invalid port) and
 *     `https://alice:pw\marker@host/api` (backslash) are both real examples, and both carry
 *     a credential. So the whole run goes. Conservative by construction: the branch that
 *     does not understand the value is the branch that prints nothing of it.
 */
function sanitizeUrlRun(run: string): string {
  const direct = parseUrl(run);
  if (direct) {
    return renderSanitizedUrl(direct);
  }

  const { url, trailing } = trimUrlDelimiters(run);
  const trimmed = url.length < run.length ? parseUrl(url) : undefined;
  if (trimmed) {
    return `${renderSanitizedUrl(trimmed)}${trailing}`;
  }

  return UNPARSABLE_URL;
}

/** Rewrite every URL inside a string, leaving the surrounding prose alone. */
function sanitizeUrlsInText(value: string): string {
  if (!value.includes('://')) {
    return value;
  }
  return value.replace(URL_RUN_PATTERN, (run) => sanitizeUrlRun(run));
}

/**
 * Escape the characters that would otherwise let a value forge a log line.
 *
 * A newline inside a logged value writes a second, attacker-chosen line into the operator's
 * log; a carriage return can hide the rest of the real one. The call sites no longer
 * interpolate caller text into a message at all (R6-W2 - messages are static and the facts
 * go in meta), and a value that reaches a rendering rule has already been vouched for by its
 * key. This runs anyway: it is the cheap half of the backstop, and "the value was vouched
 * for" is a statement about where the value came from, not about which bytes are in it.
 */
function escapeControlCharacters(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point.
  return value.replace(/[\u0000-\u001f\u007f]/g, (character) => {
    const code = character.charCodeAt(0);
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

/**
 * A real V8 stack frame, which always ends in a source location.
 *
 *     at resolveRealPath (/app/src/api/client.ts:288:15)
 *     at async createAttachment (/app/src/api/client.ts:1074:16)
 *     at processTicksAndRejections (native:7:39)
 *
 * The `:line:col` suffix is what makes this a STRUCTURAL test rather than "starts with
 * at". That matters: `stack` is just a string key, and a line reading
 * `at upload (/srv/uploads/<the caller's path>)` is frame-SHAPED prose, not a frame. The
 * engine cannot produce a frame without a location, so requiring one keeps every genuine
 * frame and refuses anything merely dressed as one.
 */
const STACK_FRAME_PATTERN = /^\s*at\s.+:\d+:\d+\)?$/;

/**
 * A stack, reduced to its frames.
 *
 * The first line of `error.stack` is `Name: message` - the prose, and the part that can
 * hold a caller's file path or an upstream body. Every other line is `at fn (file:line)`:
 * a location in this codebase's own source, which is exactly the thing worth keeping. So
 * the message line goes and the frames stay, rather than the whole stack going and
 * "where did it throw" going with it.
 */
function safeStack(stack: string): string | undefined {
  const frames = stack
    .split('\n')
    .filter((line) => STACK_FRAME_PATTERN.test(line))
    .map((line) => sanitizeUrlsInText(line.trim()));

  if (frames.length === 0) {
    return undefined;
  }
  return capString(frames.join('\n'));
}

/**
 * An Error, reduced to the fields that are stable and worth logging.
 *
 * WHY NOT PASS THE ERROR THROUGH. Winston's `format.errors({stack: true})` renders an
 * Error nicely, and that is why the previous version exempted them - but "renders nicely"
 * means "prints message and stack verbatim", and those two strings are not this
 * codebase's to print: `assertUploadPathAllowed()` interpolates the caller's `file_path`
 * and the resolved target into its message, and an axios error's message can quote the
 * upstream response.
 *
 * WHY THIS IS NOT A BLIND SPOT. What a log needs from an error is which KIND it was,
 * whether it was an upstream refusal and which one, and where it came from. All three are
 * machine-stable and none of them is prose:
 *  - `error_name`  - the constructor name (`AxiosError`, `ZodError`, `Error`).
 *  - `error_code`  - node/axios enum codes: `ENOENT`, `ECONNREFUSED`, `ERR_BAD_REQUEST`.
 *  - `error_status` - the HTTP status, read from either shape axios puts it in.
 *  - `error_stack` - the frame list.
 * Only `error_message` is dropped to a size, because only it is free text.
 *
 * The `error_` prefix keeps these out of Winston's way: a bare `message` key in meta is
 * APPENDED to the log line's own message, and a bare `name`/`stack` would collide with
 * fields the formats already use.
 */
interface SafeError {
  error_name: string;
  error_code?: string | number;
  error_status?: number;
  error_message: string;
  error_stack?: string;
}

/** Read a property that may or may not exist on an error subclass, without `any`. */
function errorProperty(error: Error, key: string): unknown {
  return (error as unknown as Record<string, unknown>)[key];
}

function toSafeError(error: Error): SafeError {
  const safe: SafeError = {
    error_name: capString(escapeControlCharacters(error.name)),
    error_message: redactedSize(error.message),
  };

  const code = errorProperty(error, 'code');
  if (typeof code === 'string' || typeof code === 'number') {
    safe.error_code = typeof code === 'string' ? capString(escapeControlCharacters(code)) : code;
  }

  // Axios puts the status on the error itself in newer versions and under `response` in
  // older ones; read both rather than depend on which is installed.
  const directStatus = errorProperty(error, 'status');
  const response = errorProperty(error, 'response');
  const nestedStatus =
    typeof response === 'object' && response !== null
      ? (response as Record<string, unknown>).status
      : undefined;
  const status = typeof directStatus === 'number' ? directStatus : nestedStatus;
  if (typeof status === 'number') {
    safe.error_status = status;
  }

  if (typeof error.stack === 'string') {
    const frames = safeStack(error.stack);
    if (frames !== undefined) {
      safe.error_stack = frames;
    }
  }

  return safe;
}

/**
 * Report a value's size instead of its contents.
 *
 * Numbers and booleans pass through: they carry no prose and are frequently the whole
 * point of the line (`status: 422`, `code: 422` inside an upstream body).
 */
function describeOpaque(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactedSize(value);
  }
  try {
    return `[redacted: ${JSON.stringify(value)?.length ?? 0} chars of JSON]`;
  } catch {
    // Cyclic or otherwise unserialisable: the size is unknowable, the contents still go.
    return '[redacted]';
  }
}

/**
 * What may become of a string, decided by the KEY it arrived under.
 *
 *  - `withhold`   - the default: report its size and nothing else.
 *  - `render`     - SAFE_STRING_KEY_PATTERN: URL-sanitize, escape, cap.
 *  - `vocabulary` - VOCABULARY_KEY_PATTERN: render it only if this process registered it.
 */
type StringPolicy = 'withhold' | 'render' | 'vocabulary';

/** Apply one policy to one string. */
function renderString(value: string, policy: StringPolicy): string {
  if (policy === 'withhold') {
    // The default, and the whole point of R5-W3's fix: no key vouched for this string.
    return redactedSize(value);
  }

  if (policy === 'vocabulary') {
    if (!isRegisteredSafeName(value)) {
      // A name this server never defined, under a key that only ever holds names this
      // server defined. R6-W2: in non-strict mode that is the caller's own text.
      return redactedSize(value);
    }
    // Byte-identical to a string this codebase registered, so there is nothing in it to
    // sanitize - and URL-sanitizing would mangle the one shape that looks like a URL,
    // rewriting the resource template 'bookstack://search/{query}' into percent-encoding.
    return capString(escapeControlCharacters(value));
  }

  // URLs first, then the cap: a credential sitting in userinfo must not survive by
  // being past the 2048th character of a long line.
  return capString(escapeControlCharacters(sanitizeUrlsInText(value)));
}

/**
 * Rebuild `value` as something safe to render.
 *
 * `policy` carries the decision made about the KEY this value arrived under, because a value
 * cannot see its own key. It is `withhold` at the root - `logger.info(msg, someString)` has
 * no key to prove anything - and an array INHERITS it, so `fields: [...]` puts every item
 * through the vocabulary check while an unknown array of strings reports sizes. It is never
 * inherited by a nested object: redactRecord re-derives the answer per property, so
 * `{url: {secret: 'x'}}` still redacts the secret.
 *
 * `seen` breaks cycles: a logger that throws or hangs on a self-referential object would
 * take the caller down with it, and axios config objects reachable from an error are
 * exactly that shape.
 */
function redactValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  policy: StringPolicy
): unknown {
  if (typeof value === 'string') {
    return renderString(value, policy);
  }

  if (value === null || typeof value !== 'object') {
    // Numbers, booleans, undefined, bigint, symbol: no size and no secrecy risk.
    return typeof value === 'bigint' || typeof value === 'symbol' ? String(value) : value;
  }

  // An Error is reduced to its stable identity rather than passed through - see
  // toSafeError for what is kept, what is dropped, and why the old pass-through leaked.
  if (value instanceof Error) {
    return toSafeError(value);
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer: ${value.length} bytes]`;
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary: ${value.byteLength} bytes]`;
  }

  if (depth >= MAX_DEPTH) {
    return '[nested too deeply]';
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => redactValue(item, depth + 1, seen, policy));
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`… [+${value.length - MAX_ARRAY_LENGTH} more items]`);
    }
    return items;
  }

  return redactRecord(value, depth, seen);
}

/**
 * Apply the key rules to one property, then recurse into whatever survives them.
 *
 * Order matters. The credential rule runs first, so nothing below can print a secret. The
 * Error rule runs before the key rules, so `{error: someError}` keeps its status and
 * frames instead of being flattened to a size by FREE_TEXT_KEY_PATTERN - the key says
 * "prose", but the value is a structure this module knows how to read.
 *
 * The last lines are where the allowlist is applied, and they are a rule rather than a list
 * of exceptions: a key nobody has vouched for hands `withhold` to redactValue, and its
 * strings come out as sizes. The keys that USED to need naming here - `file`, `html`,
 * `markdown`, `image`, `file_path` - are gone from this function because the default now
 * does their job. There is nothing to keep in step with the payload fields the tools accept.
 */
function redactEntry(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    // No length either: the length of a secret is information about the secret.
    return '[redacted]';
  }

  if (value instanceof Error) {
    return toSafeError(value);
  }

  if (STACK_KEY_PATTERN.test(key) && typeof value === 'string') {
    return safeStack(value) ?? redactedSize(value);
  }

  if (FREE_TEXT_KEY_PATTERN.test(key)) {
    return describeOpaque(value);
  }

  return redactValue(value, depth + 1, seen, stringPolicyFor(key));
}

/** Which of the three things may become of a string arriving under `key`. */
function stringPolicyFor(key: string): StringPolicy {
  if (VOCABULARY_KEY_PATTERN.test(key)) {
    return 'vocabulary';
  }
  if (SAFE_STRING_KEY_PATTERN.test(key)) {
    return 'render';
  }
  return 'withhold';
}

/** Rebuild an object property by property. */
function redactRecord(
  value: object,
  depth: number,
  seen: WeakSet<object>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = redactEntry(key, item, depth, seen);
  }
  return result;
}

/**
 * Make the log line's own message safe.
 *
 * NOT redacted: the message is a string constant this codebase wrote, and blanking it would
 * leave the line meaningless.
 *
 * WHY IT IS STILL ESCAPED, SANITIZED AND CAPPED. Until R6-W2 that "string constant" was a
 * half-truth: `Tool called: ${name}` and `Resource requested: ${uri}` interpolated caller
 * text into the message, and a message is the one thing this module does not redact - so an
 * ordinary read of `bookstack://search/{query}` wrote the caller's search terms to the
 * operator's log at the DEFAULT level, and nothing in meta had to leak for it to happen.
 * Those call sites now pass static messages and put the facts in meta, where the rules
 * above apply. This stays because the invariant "no call site interpolates" is one an edit
 * three files away can break silently, and because escaping is what stops a newline from
 * forging a second log line.
 */
function sanitizeMessage(message: string): string {
  return capString(escapeControlCharacters(sanitizeUrlsInText(message)));
}

/**
 * Make one `meta` argument safe to log. Exported so the redaction rules can be exercised
 * directly rather than only through Winston's output.
 */
export function redactLogMeta(meta: unknown): unknown {
  if (meta === undefined) {
    return undefined;
  }
  // `withhold`: a bare `logger.info('msg', someString)` has no key, so nothing has vouched
  // for it. The root is exactly where an unvouched-for string would otherwise walk in.
  return redactValue(meta, 0, new WeakSet<object>(), 'withhold');
}

/** As `redactLogMeta`, for bound child metadata, whose record shape must be preserved. */
export function redactLogRecord(meta: Record<string, unknown>): Record<string, unknown> {
  return redactRecord(meta, 0, new WeakSet<object>());
}

/** Build the Winston format matching `format`. */
function buildFormat(format: LogFormat): winston.Logform.Format {
  if (format === 'json') {
    return winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );
  }

  return winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp} [${level}] ${message}${metaStr}`;
    })
  );
}

/** Construct a Winston logger for `options`, always writing to stderr. */
function createWinstonLogger(options: LoggingOptions): WinstonLogger {
  return winston.createLogger({
    level: options.level,
    format: buildFormat(options.format),
    transports: [new winston.transports.Console({ stderrLevels: STDERR_LEVELS })],
  });
}

/**
 * Logger utility using Winston.
 *
 * A singleton, so it necessarily exists before the config that describes it.
 * `configure()` closes that gap: ConfigManager applies the validated
 * `config.logging` as soon as it has parsed it, and again on `reload()`.
 */
export class Logger {
  private static instance: Logger;
  private logger: WinstonLogger;
  private options: LoggingOptions;

  private constructor(options: LoggingOptions = DEFAULT_OPTIONS) {
    this.options = options;
    this.logger = createWinstonLogger(options);
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Apply logging settings from the validated config.
   *
   * Rebuilds the underlying Winston logger, because `level` and `format` are
   * fixed when a Winston logger is created. Idempotent, and cheap enough to
   * call on every config reload.
   */
  configure(options: LoggingOptions): void {
    this.options = options;
    this.logger = createWinstonLogger(options);
  }

  /** The settings currently in effect. */
  getOptions(): LoggingOptions {
    return this.options;
  }

  /**
   * Hand one line to Winston, redacted.
   *
   * The level check comes first so that a suppressed line - `debug` under the default
   * `info`, typically - costs nothing to walk. It also means redaction can afford to be
   * thorough: it only ever runs on something that is about to be written.
   */
  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (!this.logger.isLevelEnabled(level)) {
      return;
    }

    if (meta === undefined) {
      this.logger.log(level, sanitizeMessage(message));
      return;
    }

    this.logger.log(level, sanitizeMessage(message), redactLogMeta(meta));
  }

  debug(message: string, meta?: unknown): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write('error', message, meta);
  }

  /** Bound metadata is redacted too: it is rendered onto every line the child writes. */
  child(meta: Record<string, unknown>): Logger {
    const childLogger = new Logger(this.options);
    childLogger.logger = this.logger.child(redactLogRecord(meta));
    return childLogger;
  }
}

export default Logger;
