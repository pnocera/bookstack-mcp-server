/**
 * Integration-test harness for a live BookStack instance.
 *
 * The hard problem this module solves: BookStack only exposes API-token
 * creation through its web UI, which makes unattended integration testing
 * impossible out of the box. We provision a token *programmatically* by
 * writing the token record straight into the app's database through
 * `php artisan tinker`, running inside the `bookstack` compose service.
 *
 * See docs/integration-testing.md for the full story and the gotchas.
 */

import { spawn } from 'bun';

/** Default URL the compose stack publishes BookStack on (see docker-compose.yml). */
const DEFAULT_APP_URL = 'http://localhost:6875';

/**
 * Fixed credentials for the test token. Using constants (rather than random
 * values) is what makes provisioning idempotent: re-running the suite finds
 * and rewrites the same row instead of piling up tokens.
 *
 * BookStack requires token_id / secret to be 32 chars (the UI generates
 * 32-char random strings); these are padded to match.
 */
const TOKEN_ID = 'mcpintegtokenid0000000000000000';
const TOKEN_SECRET = 'mcpintegsecret000000000000000000';
const TOKEN_NAME = 'MCP Integration Tests';

/** The user the token is bound to. The linuxserver image seeds this admin. */
const TOKEN_USER_EMAIL = 'admin@admin.com';

/** Compose service name of the BookStack container. */
const BOOKSTACK_SERVICE = 'bookstack';

/**
 * How long the token probe will ride out HTTP 429 before giving up.
 *
 * BookStack throttles the API per user over a 60s window, so one full window
 * plus slack is enough to clear any throttle we caused ourselves. Bounded on
 * purpose: a suite must fail in finite time rather than hang. Callers with a
 * tighter beforeAll budget can pass their own.
 */
const DEFAULT_THROTTLE_BUDGET_MS = 70_000;

/** Ceiling on a single sleep, so an absurd Retry-After can't park a run for hours. */
const MAX_SINGLE_WAIT_MS = 65_000;

/** Floor on a single sleep, so `Retry-After: 0` can't spin us hot. */
const MIN_SINGLE_WAIT_MS = 1000;

/** Sleep used when a 429 arrives with no usable hint about when to come back. */
const FALLBACK_WAIT_MS = 5000;

/**
 * Anything above this can only be a UNIX timestamp, never a delta in seconds:
 * 1e9 seconds is ~31 years. Used to tell the two encodings of
 * `X-RateLimit-Reset` apart.
 */
const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;

/** Repo root — `docker compose` must run where docker-compose.yml lives. */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;

export interface BookStackHarness {
  /** API base URL, including the `/api` suffix (e.g. http://localhost:6875/api). */
  baseUrl: string;
  /** Token in `id:secret` form, ready for `Authorization: Token <token>`. */
  token: string;
}

/**
 * Minimal view of a BookStack book.
 *
 * Deliberately narrow: BookStack returns many more fields, but these are the
 * ones the integration suite relies on. Widen it as suites need more, rather
 * than mirroring the whole API surface.
 */
export interface BookStackBook {
  id: number;
  name: string;
  slug: string;
  description: string;
}

/** Envelope returned by BookStack's list endpoints (e.g. `GET /books`). */
export interface BookStackList<T> {
  data: T[];
  total: number;
}

/** An entry in the recycle bin — a soft-deleted entity awaiting purge. */
export interface RecycleBinEntry {
  id: number;
  deletable_type: string;
  deletable_id: number;
}

/** Root app URL (no `/api`), overridable for non-default setups. */
export function appUrl(): string {
  return process.env.BOOKSTACK_TEST_URL?.replace(/\/+$/, '') ?? DEFAULT_APP_URL;
}

/** API base URL, including the `/api` suffix. */
export function apiUrl(): string {
  return `${appUrl()}/api`;
}

/** The `id:secret` token string this harness provisions. */
export function tokenString(): string {
  return `${TOKEN_ID}:${TOKEN_SECRET}`;
}

/**
 * Cheap liveness probe: is BookStack answering HTTP at all?
 *
 * Deliberately does not check auth or status codes — a redirect to /login
 * (302) means the app is up and serving, which is all this answers. Never
 * throws; a dead port / DNS failure resolves to `false`.
 */
export async function isBookStackAvailable(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(appUrl(), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Poll until BookStack serves HTTP or we run out of patience.
 *
 * First boot runs DB migrations and can take several minutes, so callers
 * should budget generously rather than assume a fixed sleep is enough.
 */
export async function waitForBookStack(timeoutMs = 300_000, intervalMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBookStackAvailable()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/** Run a command without a shell (no quoting hazards), capturing output. */
async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = spawn({ cmd, cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

/**
 * The verdict on a token, keeping "the server won't talk to us right now" apart
 * from "this token is no good" — a distinction HTTP 429 makes essential and a
 * bare boolean cannot express.
 */
export type TokenProbe =
  /** HTTP 200: authenticated. */
  | { outcome: 'valid' }
  /** HTTP 401/403: the token is genuinely rejected. Reported immediately. */
  | { outcome: 'invalid'; status: number }
  /** HTTP 429 for longer than the budget allowed. Says nothing about the token. */
  | { outcome: 'throttled'; waitedMs: number }
  /** Network failure or an unexpected status — inconclusive. */
  | { outcome: 'unreachable'; detail: string };

/**
 * How long until the rate-limit window reopens, per the response headers.
 *
 * Prefers `Retry-After` (RFC 9110: delta-seconds or an HTTP-date), falling back
 * to `X-RateLimit-Reset`. Laravel — which BookStack is built on — sends the
 * latter as a UNIX timestamp, but the header is not standardised and other
 * servers send a delta, so both encodings are handled.
 *
 * Returns undefined when neither header yields a usable number; the caller then
 * picks a fallback rather than trusting a garbage value.
 */
function parseRateLimitWaitMs(res: Response, now = Date.now()): number | undefined {
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const httpDate = Date.parse(retryAfter);
    if (!Number.isNaN(httpDate)) return Math.max(0, httpDate - now);
  }

  const reset = res.headers.get('X-RateLimit-Reset');
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value)) {
      return value > EPOCH_SECONDS_THRESHOLD
        ? Math.max(0, value * 1000 - now) // UNIX timestamp
        : Math.max(0, value * 1000); // delta in seconds
    }
  }

  return undefined;
}

/**
 * Ask the live API what it thinks of `token`, riding out throttling.
 *
 * The subtlety this exists for: a throttled request is rejected with 429 *before*
 * BookStack ever looks at the token, so a 429 carries no information about
 * whether the token is good. Treating it as a failure — as a `status === 200`
 * check does — turns "we are going too fast" into "this token is unauthenticated",
 * which is how the harness used to end up re-provisioning a perfectly good token
 * and blaming the admin's `access-api` permission.
 *
 * So: 429 means wait and ask again, within a bounded budget. 401/403 is a real
 * answer and returns at once — a bad token still fails fast and loudly.
 *
 * Laravel rejects a throttled request without incrementing its counter, so
 * re-probing while over the limit costs nothing and cannot extend the window.
 */
export async function probeToken(
  token: string,
  budgetMs = DEFAULT_THROTTLE_BUDGET_MS
): Promise<TokenProbe> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${apiUrl()}/books?count=1`, {
        headers: { Authorization: `Token ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      return { outcome: 'unreachable', detail: String(error) };
    }

    if (res.status === 200) return { outcome: 'valid' };

    // A real verdict on the token. Never wait on these.
    if (res.status === 401 || res.status === 403) {
      return { outcome: 'invalid', status: res.status };
    }

    if (res.status !== 429) {
      return { outcome: 'unreachable', detail: `HTTP ${res.status}` };
    }

    // Throttled: the token is fine, the window is closed. Wait it out if the
    // budget allows, otherwise report the throttle honestly.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { outcome: 'throttled', waitedMs: budgetMs };

    const hinted = parseRateLimitWaitMs(res) ?? FALLBACK_WAIT_MS;
    const wait = Math.min(Math.max(hinted, MIN_SINGLE_WAIT_MS), MAX_SINGLE_WAIT_MS);
    if (wait > remaining) return { outcome: 'throttled', waitedMs: budgetMs };

    // Small cushion: come back just after the window rolls, not exactly on it.
    await Bun.sleep(wait + 250);
  }
}

/**
 * Does `token` authenticate against the live API right now?
 *
 * Rides out throttling like probeToken() does, so a 429 never reads as `false`.
 * Note what `false` therefore means: "not proven valid" — a rejected token, an
 * unreachable server, or a throttle that outlasted the budget. When you need to
 * tell those apart (and any error message shown to a human does), use
 * probeToken() directly.
 */
export async function tokenWorks(
  token: string,
  budgetMs = DEFAULT_THROTTLE_BUDGET_MS
): Promise<boolean> {
  const probe = await probeToken(token, budgetMs);
  return probe.outcome === 'valid';
}

/**
 * PHP executed inside the BookStack container to create/refresh the token.
 *
 * Two details are load-bearing, and both fail *silently* if you get them wrong:
 *
 *  1. `ApiToken` declares `protected $fillable = ['name', 'expires_at']`, so
 *     mass assignment (create/updateOrCreate/fill) silently DROPS token_id,
 *     secret and user_id — you get a saved row, a real id, and a token that
 *     can never authenticate. `forceFill` bypasses the fillable guard.
 *  2. `secret` is compared with `Hash::check()`, so it must be stored as a
 *     bcrypt hash; `token_id` is stored in plain text and looked up directly.
 *
 * Find-then-forceFill (rather than updateOrCreate) keeps this idempotent:
 * re-running rewrites the same row instead of erroring on the unique
 * token_id index.
 */
const PROVISION_PHP = `
$user = \\BookStack\\Users\\Models\\User::query()->where("email", "=", "${TOKEN_USER_EMAIL}")->first();
if (!$user) { echo "PROVISION_FAIL no user ${TOKEN_USER_EMAIL}" . PHP_EOL; exit(1); }
$token = \\BookStack\\Api\\ApiToken::query()->where("token_id", "=", "${TOKEN_ID}")->first()
         ?: new \\BookStack\\Api\\ApiToken();
$token->forceFill([
  "name"       => "${TOKEN_NAME}",
  "token_id"   => "${TOKEN_ID}",
  "secret"     => \\Illuminate\\Support\\Facades\\Hash::make("${TOKEN_SECRET}"),
  "user_id"    => $user->id,
  "expires_at" => \\Illuminate\\Support\\Carbon::now()->addYears(5)->format("Y-m-d"),
])->save();
echo "PROVISION_OK id=" . $token->id . PHP_EOL;
`;

/**
 * Create (or refresh) the integration API token inside the running container.
 * Idempotent: safe to call on every suite run.
 *
 * Retries because BookStack starts serving HTTP slightly before first-boot
 * seeding has created the admin user; on a cold volume the first attempt can
 * lose that race and report "no user admin@admin.com".
 */
export async function provisionToken(attempts = 5, delayMs = 5000): Promise<string> {
  let last = { stdout: '', stderr: '' };

  for (let i = 0; i < attempts; i++) {
    const res = await run([
      'docker',
      'compose',
      'exec',
      '-T',
      BOOKSTACK_SERVICE,
      'php',
      '/app/www/artisan',
      'tinker',
      '--execute',
      PROVISION_PHP,
    ]);

    if (res.ok && res.stdout.includes('PROVISION_OK')) {
      return tokenString();
    }

    last = { stdout: res.stdout, stderr: res.stderr };
    if (i < attempts - 1) await Bun.sleep(delayMs);
  }

  throw new Error(
    `Failed to provision BookStack API token via artisan tinker after ${attempts} attempts.\n` +
      `stdout: ${last.stdout.trim()}\nstderr: ${last.stderr.trim()}\n` +
      `Is the '${BOOKSTACK_SERVICE}' compose service running? Try: docker compose up -d db bookstack`
  );
}

/** Message for a throttle that outlasted the budget. Names the real cause. */
function throttleError(waitedMs: number): Error {
  return new Error(
    `BookStack is still rate-limiting this token after ${Math.round(waitedMs / 1000)}s at ${apiUrl()}.\n` +
      `The token is fine — the API returned HTTP 429 (throttled), not an auth error.\n` +
      `BookStack throttles per user over a 60s window, so this usually means several\n` +
      `suites (or several agents) are sharing one token. Re-run with fewer in parallel,\n` +
      `or wait for the window to reopen.`
  );
}

/**
 * Ensure a usable BookStack instance and API token.
 *
 * Reuses an already-working token when there is one, and only shells into the
 * container when it actually needs to. Verifies the token against the live API
 * before returning, so a caller that gets a value can trust it.
 *
 * Every failure path names the cause it actually observed: a throttle says
 * "throttled", a rejected token says "check access-api", and neither is
 * reported as the other.
 */
export async function ensureBookStack(
  throttleBudgetMs = DEFAULT_THROTTLE_BUDGET_MS
): Promise<BookStackHarness> {
  if (!(await isBookStackAvailable(5000))) {
    throw new Error(
      `BookStack is not reachable at ${appUrl()}.\n` +
        `Start it with: docker compose up -d db bookstack  (first boot takes several minutes)`
    );
  }

  const token = tokenString();
  const harness = { baseUrl: apiUrl(), token };

  // Fast path: token already provisioned by an earlier run.
  const first = await probeToken(token, throttleBudgetMs);
  if (first.outcome === 'valid') return harness;

  // Throttled, not unauthenticated. Re-provisioning would neither help nor be
  // honest about what happened, so don't: the token was never in question.
  if (first.outcome === 'throttled') throw throttleError(first.waitedMs);

  // 'invalid' (no token yet — the expected first-run state) or 'unreachable'
  // (transient). Provisioning is idempotent, so it is safe to try for both.
  await provisionToken();

  const second = await probeToken(token, throttleBudgetMs);
  if (second.outcome === 'valid') return harness;

  if (second.outcome === 'throttled') throw throttleError(second.waitedMs);

  if (second.outcome === 'unreachable') {
    throw new Error(
      `Provisioned an API token but ${apiUrl()} did not give a usable answer: ${second.detail}.\n` +
        `This is not an auth failure — the API never got far enough to judge the token.\n` +
        `Check the '${BOOKSTACK_SERVICE}' container's logs: docker compose logs ${BOOKSTACK_SERVICE}`
    );
  }

  throw new Error(
    `Provisioned an API token but it still fails to authenticate against ${apiUrl()} ` +
      `(HTTP ${second.status}).\n` +
      `Check that the '${TOKEN_USER_EMAIL}' user's role has the 'access-api' permission.`
  );
}

/**
 * Should the integration suite run?
 *
 *   RUN_INTEGRATION=1  -> force run (fail loudly if BookStack is missing)
 *   RUN_INTEGRATION=0  -> force skip
 *   unset              -> auto: run iff BookStack is reachable
 *
 * The auto case is what keeps a plain `bun test` green on a machine with no
 * Docker: unreachable BookStack simply skips the suite.
 */
export async function shouldRunIntegration(): Promise<boolean> {
  const flag = process.env.RUN_INTEGRATION;
  if (flag === '0' || flag === 'false') return false;
  if (flag === '1' || flag === 'true') return true;
  return await isBookStackAvailable();
}

/** Authenticated fetch against the BookStack API. `path` is relative, e.g. "/books". */
export async function apiFetch(
  harness: BookStackHarness,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Token ${harness.token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return await fetch(`${harness.baseUrl}${path}`, { ...init, headers });
}

/**
 * Parse a JSON response body as a known shape.
 *
 * `Response.json()` resolves to `unknown` under this repo's strict config, so
 * without this every call site would need its own cast. Keeping the narrowing
 * here means exactly one auditable place to review.
 *
 * Note the honest limitation: `as T` is an *assertion*, not validation — it
 * trusts the shape the caller declares. What it does guarantee is that the
 * body really was JSON, turning a stray HTML error page into a clear message
 * here instead of a baffling `undefined` property access three lines later.
 * Tests still assert on the actual field values, which is what catches a
 * genuinely wrong shape.
 */
export async function apiJson<T>(res: Response): Promise<T> {
  let body: unknown;

  try {
    body = await res.json();
  } catch (error) {
    throw new Error(
      `Expected JSON from ${res.url} (HTTP ${res.status}) but the body failed to parse: ${String(error)}`
    );
  }

  if (body === null || typeof body !== 'object') {
    throw new Error(
      `Expected a JSON object from ${res.url} (HTTP ${res.status}) but got: ${JSON.stringify(body)}`
    );
  }

  return body as T;
}

/** How many times a cleanup call re-issues a request BookStack answered with 429. */
const CLEANUP_RETRY_ATTEMPTS = 6;

/**
 * `apiFetch()` that rides out the shared instance's rate limiter.
 *
 * Only 429 is retried, and the wait comes from the response's own headers, so a
 * real failure (404, 422, 500) is returned on the first attempt and still fails
 * the caller. Every suite had grown its own copy of this loop; cleanup needs one
 * that is definitely correct, so it lives here.
 */
export async function apiFetchRetrying(
  harness: BookStackHarness,
  path: string,
  init: RequestInit = {},
  attempts = CLEANUP_RETRY_ATTEMPTS
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await apiFetch(harness, path, init);
    if (res.status !== 429 || attempt >= attempts) return res;

    const hinted = parseRateLimitWaitMs(res) ?? FALLBACK_WAIT_MS;
    const wait = Math.min(Math.max(hinted, MIN_SINGLE_WAIT_MS), MAX_SINGLE_WAIT_MS);
    await Bun.sleep(wait + 250);
  }
}

/** Some of the response body, for an error message that names what went wrong. */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? ` body: ${text.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

/**
 * Find this entity's deletion row, paging through the bin.
 *
 * Paging rather than one `count=500` read: the bin is shared, concurrently
 * filled state, and a row that fell onto page two used to read as "nothing to
 * purge" — which is precisely how a fixture leaks.
 */
async function findDeletionRow(
  harness: BookStackHarness,
  deletableType: string,
  deletableId: number
): Promise<RecycleBinEntry | undefined> {
  const pageSize = 500;
  const maxPages = 20;

  for (let page = 0; page < maxPages; page++) {
    const res = await apiFetchRetrying(
      harness,
      `/recycle-bin?count=${pageSize}&offset=${page * pageSize}`
    );
    if (res.status !== 200) {
      throw new Error(
        `GET /recycle-bin answered HTTP ${res.status}${await bodySnippet(res)} — cannot tell whether ` +
          `${deletableType} ${deletableId} still has a deletion row`
      );
    }

    const body = await apiJson<BookStackList<RecycleBinEntry>>(res);
    const rows = body.data ?? [];
    const match = rows.find(
      (entry) => entry.deletable_type === deletableType && entry.deletable_id === deletableId
    );
    if (match) return match;
    if (rows.length < pageSize) return undefined;
  }

  throw new Error(`Paged ${maxPages * pageSize} recycle-bin rows without reaching the end`);
}

/**
 * Permanently remove a soft-deleted entity from the recycle bin.
 *
 * `DELETE /books/{id}` only *soft* deletes: the book vanishes from `GET /books`
 * but lives on in the recycle bin. Tests that only call `DELETE /books/{id}`
 * therefore leak rows into every subsequent run. This finds the matching
 * deletion record and destroys it for real.
 *
 * Returns true when a row was found and purged, false when there was no row to
 * purge — an honest "nothing to do", which is what a caller that already purged
 * its own entry sees.
 *
 * WHAT CHANGED, AND WHY IT MATTERS. This used to catch every error and fold it
 * into `false`, on the reasoning that cleanup must not turn a passing test red.
 * That reasoning is backwards: it makes a failed purge indistinguishable from an
 * empty bin, and most callers ignored the boolean anyway. The live instance
 * settled the argument — after an all-green run it still held role 117
 * (`itest-role-filter-other-...`), two `itest-bin-restore-*` books and three
 * `itest-bin-*` deletion rows. A throw is the only thing a caller cannot ignore.
 */
export async function purgeFromRecycleBin(
  harness: BookStackHarness,
  deletableType: string,
  deletableId: number
): Promise<boolean> {
  const entry = await findDeletionRow(harness, deletableType, deletableId);
  if (!entry) return false;

  const purgeRes = await apiFetchRetrying(harness, `/recycle-bin/${entry.id}`, {
    method: 'DELETE',
  });
  // 200 carries `{delete_count}`; 404 means a concurrent purge beat us to it,
  // which is the outcome we wanted either way. Anything else is a real failure.
  if (purgeRes.status !== 200 && purgeRes.status !== 404) {
    throw new Error(
      `DELETE /recycle-bin/${entry.id} (${deletableType} ${deletableId}) answered ` +
        `HTTP ${purgeRes.status}${await bodySnippet(purgeRes)}`
    );
  }

  // Verify rather than trust: re-read the bin. A purge BookStack accepted but
  // did not perform would otherwise read exactly like one it honoured.
  const survivor = await findDeletionRow(harness, deletableType, deletableId);
  if (survivor) {
    throw new Error(
      `Recycle-bin entry ${survivor.id} for ${deletableType} ${deletableId} survived its purge ` +
        `(DELETE answered HTTP ${purgeRes.status})`
    );
  }

  return true;
}

/**
 * The BookStack collections cleanup can delete from, keyed by the name the
 * recycle bin uses for that entity in `deletable_type` where it has one.
 */
const CLEANUP_COLLECTIONS = {
  attachment: '/attachments',
  image: '/image-gallery',
  page: '/pages',
  chapter: '/chapters',
  book: '/books',
  bookshelf: '/shelves',
  user: '/users',
  role: '/roles',
} as const;

/** An entity kind `CleanupTracker` knows how to remove and then verify gone. */
export type CleanupKind = keyof typeof CLEANUP_COLLECTIONS;

/**
 * Kinds whose DELETE is *soft*: the entity leaves its listing but lives on as a
 * recycle-bin deletion row that has to be purged separately. Verified against
 * v26.05.2 — books, chapters, pages and shelves soft-delete; users, roles,
 * images and attachments are destroyed outright.
 */
const SOFT_DELETED_KINDS: ReadonlySet<CleanupKind> = new Set([
  'book',
  'chapter',
  'page',
  'bookshelf',
]);

/**
 * The order teardown runs in, so nothing is deleted out from under something
 * that still refers to it: uploads before the page holding them, content before
 * its shelf, and users before the roles they are assigned (deleting a role that
 * still has members strips them silently).
 */
const CLEANUP_ORDER: readonly CleanupKind[] = [
  'attachment',
  'image',
  'page',
  'chapter',
  'book',
  'bookshelf',
  'user',
  'role',
];

/** Statuses a cleanup DELETE may legitimately answer: done, or already gone. */
const DELETE_OK_STATUSES: ReadonlySet<number> = new Set([200, 204, 404]);

interface TrackedEntity {
  kind: CleanupKind;
  id: number;
}

/**
 * Tracks what a suite created and removes it in `afterAll` — loudly.
 *
 * WHY THIS EXISTS. Every suite used to hand-roll teardown as a
 * `fetch(...).catch(() => {})` loop. That is silent by construction, and for a
 * reason easy to miss: **`fetch` resolves normally for 4xx and 5xx**. It rejects
 * only on a network failure. So `.catch(() => {})` suppresses nothing that
 * actually happens, while a delete BookStack *refused* — 422, 500, a 429 the
 * loop never retried — resolved like a success and the id was dropped anyway.
 * Teardown then reported nothing at all, and the fixture stayed.
 *
 * This is not hypothetical. After an all-green run the live instance still held
 * role 117 (`itest-role-filter-other-...`), two restored `itest-bin-restore-*`
 * books, and three `itest-bin-*` deletion rows, while every suite claimed a
 * clean exit.
 *
 * So this class believes nothing it is told:
 *
 *   - it retries 429 (the shared budget is not a failure) and accepts **only**
 *     the statuses that mean the entity is gone — 200/204 for "deleted now",
 *     404 for "a test already deleted it";
 *   - it purges the recycle-bin row for a soft-deleted kind rather than leaving
 *     one behind;
 *   - it re-reads every entity by id afterwards, because an accepted delete and
 *     a performed delete are different claims;
 *   - it records **every** failure instead of stopping at the first, so one
 *     stuck fixture cannot hide the next; and
 *   - it throws from `run()` listing all of them, which fails `afterAll`.
 *
 * A test keeps its own assertion failure — teardown runs afterwards and reports
 * separately. What it may not do is leak in silence.
 */
export class CleanupTracker {
  private readonly tracked: TrackedEntity[] = [];

  /**
   * Record an entity to remove in teardown. Call it at creation time, not after
   * the assertions: an entity tracked only on the happy path is exactly the one
   * a failing test leaves behind.
   */
  track(kind: CleanupKind, id: number): void {
    if (!this.tracked.some((entity) => entity.kind === kind && entity.id === id)) {
      this.tracked.push({ kind, id });
    }
  }

  /**
   * Remove everything tracked, then prove it is gone. Throws if anything is not.
   *
   * A test that deleted its own entity needs no special handling: the DELETE
   * 404s, the verification passes, and teardown double-checks the test's claim
   * for free.
   */
  async run(harness: BookStackHarness): Promise<void> {
    const failures: string[] = [];

    for (const kind of CLEANUP_ORDER) {
      // Newest first: an entity created later may depend on an earlier one.
      const ids = this.tracked
        .filter((entity) => entity.kind === kind)
        .map((entity) => entity.id)
        .reverse();

      for (const id of ids) {
        const failure = await this.remove(harness, kind, id);
        if (failure) failures.push(failure);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Integration cleanup left ${failures.length} entit${failures.length === 1 ? 'y' : 'ies'} ` +
          `behind on ${apiUrl()}. Each is residue that a later run will trip over:\n` +
          failures.map((failure) => `  - ${failure}`).join('\n')
      );
    }
  }

  /** Remove one entity. Resolves to a description of the failure, or undefined. */
  private async remove(
    harness: BookStackHarness,
    kind: CleanupKind,
    id: number
  ): Promise<string | undefined> {
    const path = `${CLEANUP_COLLECTIONS[kind]}/${id}`;

    try {
      const deleteRes = await apiFetchRetrying(harness, path, { method: 'DELETE' });
      if (!DELETE_OK_STATUSES.has(deleteRes.status)) {
        return `${kind} ${id}: DELETE ${path} answered HTTP ${deleteRes.status}${await bodySnippet(deleteRes)}`;
      }

      if (SOFT_DELETED_KINDS.has(kind)) {
        // Soft delete: the entity is out of its listing but the deletion row is
        // not. Purging is what actually removes it.
        await purgeFromRecycleBin(harness, kind, id);
      }

      // The whole point: an accepted DELETE is a claim, not evidence.
      const readRes = await apiFetchRetrying(harness, path);
      if (readRes.status !== 404) {
        return `${kind} ${id}: still present after cleanup — GET ${path} answered HTTP ${readRes.status} (expected 404)`;
      }

      return undefined;
    } catch (error) {
      return `${kind} ${id}: cleanup failed — ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
