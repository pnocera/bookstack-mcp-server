import { createHash } from 'node:crypto';

/**
 * OUTBOUND rate limiting for BookStack API requests.
 *
 * Two things live here, and the second is the reason the first is not enough:
 *
 *  - `RateLimiter`, a token bucket that is safe to share between concurrent callers.
 *  - `getSharedRateLimiter()`, the registry that makes one bucket per *outbound identity*
 *    rather than one per object that happens to want a bucket.
 *
 * WHY THE REGISTRY EXISTS.
 *
 * `POST /message` builds a fresh `BookStackMCPServer` per request, which builds a fresh
 * `BookStackClient`. When each client also built its own `RateLimiter`, every HTTP request
 * started with a completely full bucket, so RATE_LIMIT_REQUESTS_PER_MINUTE and
 * RATE_LIMIT_BURST_LIMIT limited nothing at all on the default transport: a caller could
 * spend the whole burst allowance again on each RPC, and concurrent RPCs each got a
 * private bucket, so the overshoot scaled with concurrency. Verified by probing the real
 * Express route with burstLimit=1: two sequential tools/call requests both reached the
 * upstream immediately.
 *
 * The budget being protected belongs to the BookStack instance and the token being spent,
 * not to a JS object's lifetime - so the bucket has to be keyed by that identity and
 * outlive the request that first needed it.
 */

/** Pause for `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The knobs a bucket is built from. Mirrors `Config['rateLimit']`. */
export interface RateLimitConfig {
  requestsPerMinute: number;
  burstLimit: number;
}

/**
 * The effective outbound identity a bucket belongs to.
 *
 * `x-bookstack-url` / `x-bookstack-token` let a caller pick a different upstream per
 * request, and two different upstreams have two different budgets, so both fields are part
 * of the identity. The limits are included as well: a bucket built for burstLimit=1 is not
 * the bucket a burstLimit=10 client asked for, and silently handing over the first would
 * make the limits depend on which caller arrived earliest.
 *
 * `baseUrl` is canonicalised before it is keyed on - see canonicalBaseUrl().
 */
export interface RateLimitIdentity extends RateLimitConfig {
  baseUrl: string;
  apiToken: string;
}

/** Schemes this server can actually reach a BookStack instance over. */
const ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** RFC 3986 unreserved characters: percent-encoding one of these carries no meaning. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * RFC 3986 6.2.2.2 percent-encoding normalisation.
 *
 * `URL` does not do this: `new URL('http://x/%61pi').pathname` stays `/%61pi` even though
 * it denotes the very same path as `/api`. Decoding the triplets that encode unreserved
 * characters, and case-folding the hex of the ones that must stay encoded, collapses those
 * spellings onto one. The result is byte-equivalent as a request target, so using it as the
 * axios `baseURL` changes nothing about what is sent.
 */
function normalizePercentEncoding(path: string): string {
  return path.replace(/%[0-9A-Fa-f]{2}/g, (triplet) => {
    const decoded = String.fromCharCode(Number.parseInt(triplet.slice(1), 16));
    return UNRESERVED.test(decoded) ? decoded : triplet.toUpperCase();
  });
}

/**
 * WHY NO REFUSAL BELOW QUOTES ANY PART OF THE URL IT REFUSES.
 *
 * Every refusal in canonicalBaseUrl() is about a URL some caller or operator supplied, and
 * the obvious way to write those messages - quote the offending value - is how the refusal
 * becomes the leak it exists to prevent. `ConfigManager` writes its failures to the log and
 * the top-level startup catch prints the thrown message, so an echoed `?api_token=...`
 * reaches exactly the readers the rule was protecting the credential from. R5-W2 was that
 * bug.
 *
 * The first fix for it kept "the three components that can never hold a credential - scheme,
 * host and path". R6-W3 is that claim being false about the path. A path is arbitrary text
 * chosen by whoever deployed the instance, and a reverse-proxy capability
 * (`https://books.example/<capability>/api`), a tenant identifier or a preview-environment
 * secret all live in precisely that position. The check that missed it tested a marker in the
 * QUERY, saw it redacted, and generalised - so `https://books.example/MARKER/api?invalid=1`
 * still echoed MARKER verbatim, out of the branch complaining about the query.
 *
 * There is no component of a supplied URL that is safe to quote by construction, so these
 * messages interpolate NOTHING. They are string constants that name the setting and the
 * offending component, which is what an operator needs to act:
 *
 *   BOOKSTACK_BASE_URL + "must not carry userinfo"  -> they know which variable, and what
 *                                                      to take out of it.
 *
 * The value is already in front of them; it is in their own environment file. What they
 * cannot recover from a log line is a secret that a log line published.
 *
 * For the NORMAL case - a base URL that is accepted, and then logged at startup - see
 * describeBaseUrl(), which has the same problem and a different answer.
 */

/**
 * Reduce a BookStack base URL to the one spelling that stands for its upstream.
 *
 * WHY THIS IS NOT COSMETIC. The bucket is keyed by outbound identity, and `baseUrl` is
 * half of that identity - so any two spellings the registry fails to collapse are two
 * independent full buckets pointed at one BookStack. `http://example.com/api` and
 * `HTTP://EXAMPLE.COM:80/api` are the same upstream by every rule `URL` implements, and
 * an authenticated caller may spell `x-bookstack-url` however it likes, so keying on the
 * raw string let a caller recover the whole burst allowance on demand.
 *
 * What is collapsed (all of it identity-preserving, i.e. the canonical form addresses the
 * exact same resource): scheme and host case, the default port for the scheme, `.`/`..`
 * path segments, percent-encoding spelling, and a trailing slash - which axios strips
 * anyway when it joins `baseURL` to a request path.
 *
 * What is REFUSED rather than collapsed, because for these there is no "same identity"
 * answer that is also safe:
 *
 *  - a non-http(s) scheme: not something this client can speak, and not something a
 *    caller should be able to steer this process into trying.
 *  - userinfo (`http://user:pass@host/api`): BookStack authenticates via the
 *    `Authorization: Token` header, so userinfo is never needed here - and it is an
 *    unbounded free-text field on the identity, i.e. exactly the alias-minting vector
 *    this function exists to close.
 *  - a query or fragment: an API *base* has neither, and both are likewise free text
 *    that would multiply buckets for one upstream.
 *
 * Idempotent by construction: canonicalBaseUrl(canonicalBaseUrl(x)) === canonicalBaseUrl(x),
 * so callers may hand it an already-canonical value.
 *
 * This lives beside the identity it defines rather than in the client, so no call path can
 * reach the registry with a raw URL: getSharedRateLimiter() canonicalises what it is given.
 * It is also what `ConfigSchema` validates BOOKSTACK_BASE_URL with, so a base URL this
 * function would refuse cannot reach a running server in the first place - see
 * src/config/manager.ts. One rule, one implementation: a second copy of it would drift.
 *
 * NO REFUSAL BELOW QUOTES ANY PART OF THE VALUE IT REFUSES - see the note above on why not
 * even the scheme, host or path is safe to interpolate.
 */
export function canonicalBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // The value is deliberately absent. Everything below can name the URL safely because
    // it parsed, so the credential-bearing components could be identified and dropped;
    // here nothing parsed, so there is no way to tell a typo from a pasted secret, and
    // quoting it would echo whatever it happens to be. The setting's name is the clue.
    throw new Error(
      'BookStack base URL is not a valid absolute URL ' +
        "(expected something like 'https://books.example.com/api')."
    );
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    // Not even the scheme it used. A scheme is a URL component like any other, and for a
    // non-http(s) one `URL` puts the whole rest of the value somewhere unpredictable -
    // `data:` and `file:` both park arbitrary text in `pathname`. Naming the two schemes
    // that ARE accepted tells the operator everything the rejected spelling would have.
    throw new Error(
      'BookStack base URL must use the http or https scheme ' +
        "(expected something like 'https://books.example.com/api')."
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'BookStack base URL must not carry userinfo (user:password@host). BookStack ' +
        'authenticates with the API token in the Authorization header; credentials in the ' +
        'URL are neither used nor logged safely.'
    );
  }

  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      'BookStack base URL must not carry a query string or fragment; it is a base ' +
        "(e.g. 'https://books.example.com/api'), not a request."
    );
  }

  // Trailing slashes are dropped: axios's buildFullPath() strips them before joining a
  // request path, so '/api' and '/api/' produce byte-identical requests.
  const path = normalizePercentEncoding(parsed.pathname).replace(/\/+$/, '');
  // `parsed.host` is already lower-cased and already omits the scheme's default port.
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * The base-URL paths this project documents, and therefore the only ones a log line may
 * spell out.
 *
 * Membership of this set is what turns "arbitrary operator text" into "a constant" - the
 * value rendered is this module's own string, selected by an equality test, rather than
 * anything that came in. '/api' is what BookStack serves its API on and what .env.example
 * ships; '' is the same instance addressed without one.
 */
const KNOWN_BASE_PATHS: ReadonlySet<string> = new Set(['', '/api']);

/** How much of the digest is shown. Enough to compare two deployments, not to be a value. */
const PATH_DIGEST_LENGTH = 12;

/**
 * A base URL reduced to what a startup line may say about it.
 *
 * WHY THIS EXISTS AT ALL. `logger.info('BookStack API client initialized', {baseUrl})` looks
 * about as harmless as a log line gets, and it is the R6-W3 leak: the redactor sanitizes a
 * URL STRUCTURALLY and deliberately keeps the path, because a path is what makes a request
 * line worth reading. That reasoning holds for `/books/5`, which this client builds, and
 * fails for the base URL, which the operator supplies - `https://books.example/<proxy
 * capability>/api` writes the capability into the log on every startup, no failure or
 * attacker required.
 *
 * SO WHAT IS LEFT IS EVERYTHING EXCEPT THE ARBITRARY PART:
 *  - `base_origin` - scheme, host and port. Which BookStack this is: the fact an operator
 *    actually reaches for when a container is talking to the wrong instance. Userinfo cannot
 *    appear (canonicalBaseUrl refuses it) and there is no path in an origin.
 *  - `base_path_segments` - how deep the path is, which distinguishes a bare `/api` from a
 *    proxied mount without saying what it is mounted under.
 *  - `base_path` - the path itself, and ONLY when it is one of KNOWN_BASE_PATHS. This is
 *    the "unless the path is an exact known constant" case, and it covers the overwhelming
 *    majority of deployments: they read `/api`, exactly as they always did.
 *  - `base_path_digest` - otherwise, a truncated SHA-256 of the path. An operator can still
 *    tell "the same custom path as yesterday" from "a different one", and can confirm which
 *    of their own paths it is by hashing it themselves, without the log holding the value.
 *
 * TOTAL BY CONSTRUCTION: it never throws, because a logging helper that throws turns a log
 * line into an outage. An input canonicalBaseUrl() would refuse cannot describe an upstream,
 * so it gets a constant that says so and no components at all.
 */
export interface BaseUrlDescription {
  base_origin: string;
  base_path_segments: number;
  base_path?: string;
  base_path_digest?: string;
}

export function describeBaseUrl(raw: string): BaseUrlDescription {
  let canonical: string;
  try {
    canonical = canonicalBaseUrl(raw);
  } catch {
    // Unreachable from the running server - ConfigSchema and BookStackClient both refuse
    // such a value long before anything logs it - which is exactly why it must not depend
    // on being unreachable.
    return { base_origin: '[unusable base URL]', base_path_segments: 0 };
  }

  const parsed = new URL(canonical);
  const path = parsed.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter((segment) => segment.length > 0);

  const description: BaseUrlDescription = {
    base_origin: parsed.origin,
    base_path_segments: segments.length,
  };

  if (KNOWN_BASE_PATHS.has(path)) {
    description.base_path = path;
  } else {
    description.base_path_digest = createHash('sha256')
      .update(path)
      .digest('hex')
      .slice(0, PATH_DIGEST_LENGTH);
  }

  return description;
}

/**
 * Token bucket, safe for concurrent use.
 *
 * `acquire()` is serialised through a FIFO chain. Without that, N callers arriving at an
 * empty bucket each computed the same wait from the same reading, all woke together, and
 * all decremented - so the bucket went negative and N requests left for a budget of one.
 * Serialising makes "wait for a token, then take it" indivisible: only the caller at the
 * head of the queue is ever looking at the token count, so `tokens` can never go below 0
 * and waiters are served in arrival order.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  /** Tokens per second. */
  private readonly refillRate: number;
  private lastRefill: number;
  /** Tail of the FIFO chain; resolves when the last queued caller has taken its token. */
  private queue: Promise<void> = Promise.resolve();
  /** Callers currently queued or waiting. Used to tell an idle bucket from a busy one. */
  private waiters = 0;

  constructor(config: RateLimitConfig) {
    this.maxTokens = config.burstLimit;
    this.tokens = this.maxTokens;
    this.refillRate = config.requestsPerMinute / 60;
    this.lastRefill = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary.
   *
   * Every call joins the queue, even one that could be served immediately: overtaking a
   * waiter would let a late arrival spend the token that waiter has been waiting for.
   */
  async acquire(): Promise<void> {
    this.waiters += 1;

    const predecessor = this.queue;
    let done: () => void = () => {};
    this.queue = new Promise<void>((resolve) => {
      done = resolve;
    });

    try {
      // A rejected predecessor must not poison the queue for everyone behind it.
      await predecessor.catch(() => {});
      await this.consumeToken();
    } finally {
      this.waiters -= 1;
      done();
    }
  }

  /**
   * Take exactly one token, sleeping until one exists.
   *
   * Only ever runs at the head of the queue. The loop re-checks rather than trusting the
   * first computed wait, because setTimeout may fire early and because `refillRate` makes
   * the deficit a real-valued estimate; re-reading the clock is what keeps the bucket from
   * ever being overdrawn.
   */
  private async consumeToken(): Promise<void> {
    this.refill();

    while (this.tokens < 1) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillRate) * 1000);
      await sleep(Math.max(waitMs, 1));
      this.refill();
    }

    this.tokens -= 1;
  }

  /** Refill tokens based on elapsed time. */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Check if a request could be served without waiting. */
  canMakeRequest(): boolean {
    this.refill();
    return this.waiters === 0 && this.tokens >= 1;
  }

  /** Get current token count. */
  getTokenCount(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Is this bucket indistinguishable from a brand-new one?
   *
   * Nobody is queued and the bucket has refilled to full, so discarding it and building a
   * fresh one later would grant exactly the same allowance. This is what makes eviction
   * safe rather than a way of handing out free burst capacity - see the registry below.
   */
  isIdle(): boolean {
    return this.waiters === 0 && this.getTokenCount() >= this.maxTokens;
  }
}

/**
 * How many IDLE buckets are kept on hand.
 *
 * This is a retention target for buckets nobody is using, NOT a ceiling on live ones -
 * see pruneIdle() for why that distinction is the whole design. 256 is far above the
 * number of real upstreams a deployment talks to (typically one), so in practice nothing
 * is ever pruned; it exists so that a caller rotating `x-bookstack-url` /
 * `x-bookstack-token` cannot leave spent buckets behind forever.
 */
const MAX_IDLE_LIMITERS = 256;

/**
 * How many entries one insertion may examine while pruning.
 *
 * Bounds the work per insert to O(1): without it, an all-live registry would rescan itself
 * on every insert, turning insertion into O(n). The budget buys a bounded step of a sweep
 * that RESUMES where the last one stopped - see pruneCursor.
 */
const PRUNE_SCAN_LIMIT = 64;

/**
 * Buckets by identity digest. Insertion order is maintained as a recency order: a hit
 * re-inserts its entry at the end, so the first entry is always the least recently used.
 */
const limiters = new Map<string, RateLimiter>();

/**
 * Where the next bounded scan resumes. `undefined` starts a fresh sweep from the front.
 *
 * THIS IS THE WHOLE OF R5-W1. The bounded scan used to restart from the front of the map on
 * every insertion, on the reasoning that idle buckets collect at the old end and anything
 * the scan missed would be reconsidered "once earlier entries are gone". They never are:
 * nothing removes a live entry, so a live prefix is rescanned and skipped forever and the
 * scan never reaches the idle garbage behind it. Codex drove it: spend the only token in the
 * first 64 buckets, fill to 256 with idle ones, insert 100 more - the registry ended at 356,
 * every insertion re-examining the same 64 live entries. The bound was honoured and the
 * guarantee it was bounding was not, which is the worst of both.
 *
 * A held Map iterator is what makes a bounded scan make PROGRESS. Map iterators are defined
 * to be live: an entry deleted before the cursor reaches it is skipped, and an entry
 * appended ahead of it is still visited. So the sweep can be paused after PRUNE_SCAN_LIMIT
 * steps and resumed on the next insertion, and every entry is visited once per sweep -
 * amortised O(1) per insert, with no O(n) snapshot of the keys. Insertion stays O(1)-ish.
 *
 * Recency ordering survives: the LRU touch in getSharedRateLimiter() re-appends its entry,
 * so it lands behind the cursor and is simply visited later.
 */
let pruneCursor: Iterator<[string, RateLimiter]> | undefined;

/**
 * Digest the identity rather than concatenating it into a key.
 *
 * The API token is a credential; a Map key holding it in plaintext would surface it in any
 * heap dump or debug dump of this module. A digest keys just as well.
 *
 * The URL is canonicalised HERE rather than trusted from the caller. This function decides
 * whether two requests are the same identity, so it is the one place where an un-collapsed
 * alias would silently become a second full bucket - see canonicalBaseUrl().
 *
 * The separator is U+0000: it cannot appear in a URL, nor in an HTTP header value, so the
 * four fields cannot be re-cut into a different identity that digests the same. It is
 * written as an escape deliberately - this was a RAW NUL byte in the source, which renders
 * as a space in most tooling and would silently degrade to '' if any editor stripped it.
 * A join on the empty string is precisely the collision-by-concatenation the paragraph
 * above promises cannot happen.
 */
function identityDigest(identity: RateLimitIdentity): string {
  return createHash('sha256')
    .update(
      [
        canonicalBaseUrl(identity.baseUrl),
        identity.apiToken,
        String(identity.requestsPerMinute),
        String(identity.burstLimit),
      ].join('\u0000')
    )
    .digest('hex');
}

/**
 * Drop idle buckets once there are more than MAX_IDLE_LIMITERS entries.
 *
 * NEVER drops a live bucket, and that restraint is the entire design.
 *
 * Evicting a bucket that is still in use does not free it - its clients, queued promises
 * and timers all still reference it - it merely unhooks it from the registry. The next
 * request for that same identity then finds nothing and is handed a BRAND NEW, FULL
 * bucket, while the evicted one's waiters are still queued on the old object. That is not
 * eviction, it is minting: the identity gets its burst allowance twice over, the upstream
 * budget this module exists to enforce is broken, and no memory is reclaimed either. A
 * caller could drive it deliberately - rotate identities until the entry it wants
 * refreshed falls off the end, then present it again.
 *
 * So the cap binds IDLE entries only, and the map may exceed MAX_IDLE_LIMITERS while they
 * are all live. That is not unbounded growth. A bucket is live only while it has waiters -
 * i.e. a request in flight, which already retains far more memory than a bucket does (a
 * whole request-scoped server) - or while it has yet to refill, which takes at most
 * burstLimit/refillRate seconds after its last use. Live entries are therefore bounded by
 * work already admitted through the transport's own authentication, and every one of them
 * becomes prunable shortly after that work stops.
 *
 * Preferring that to a hard cap is deliberate, because a hard cap can only be honoured two
 * ways, and both are worse than retaining some garbage: mint a bucket (breaks the budget),
 * or refuse to admit a new identity (lets whoever floods the table with live identities
 * deny service to the legitimate one). A soft cap on garbage is the failure worth having.
 *
 * The garbage bound is only a bound if the scan can REACH the garbage, which is what
 * pruneCursor is for: each insertion advances the sweep by up to PRUNE_SCAN_LIMIT entries
 * from wherever the last one stopped, so idle entries behind a live prefix are reclaimed a
 * bounded number of insertions later instead of never.
 */
function pruneIdle(): void {
  if (limiters.size <= MAX_IDLE_LIMITERS) {
    return;
  }

  let excess = limiters.size - MAX_IDLE_LIMITERS;
  let scanned = 0;
  let wrapped = false;

  while (excess > 0 && scanned < PRUNE_SCAN_LIMIT) {
    pruneCursor ??= limiters.entries();
    const next = pruneCursor.next();

    if (next.done) {
      // The sweep reached the end of the map. Restart from the front so garbage the cursor
      // has already passed is not held until the next insertion - but only once per call,
      // so that a registry with nothing to prune costs a bounded scan rather than a rescan.
      pruneCursor = undefined;
      if (wrapped) {
        break;
      }
      wrapped = true;
      continue;
    }

    scanned += 1;
    const [key, limiter] = next.value;
    // Dropping a full, unqueued bucket changes nothing: rebuilding it later grants exactly
    // the same allowance. That equivalence is what makes this the only safe candidate.
    if (limiter.isIdle()) {
      limiters.delete(key);
      excess -= 1;
    }
  }
}

/**
 * The bucket for one outbound identity, shared across every client that spends it.
 *
 * Returns the same `RateLimiter` for the same identity regardless of how many
 * request-scoped servers, clients or transports ask for it, which is what makes the
 * configured limit an actual limit. Different upstreams - or different tokens on one
 * upstream - get their own bucket and cannot throttle each other.
 *
 * Two properties callers depend on:
 *
 *  - Equivalent spellings of one upstream resolve to one bucket; see canonicalBaseUrl().
 *  - Once an identity has a bucket it keeps THAT bucket for as long as it is in use.
 *    Nothing here can replace a live bucket with a fresher one; see pruneIdle().
 *
 * Throws if `baseUrl` is not a usable BookStack base URL, which is also the validation of
 * the caller-supplied `x-bookstack-url` header - it reaches this before it reaches axios.
 */
export function getSharedRateLimiter(identity: RateLimitIdentity): RateLimiter {
  const key = identityDigest(identity);

  const existing = limiters.get(key);
  if (existing) {
    // Re-insert to mark as most recently used.
    limiters.delete(key);
    limiters.set(key, existing);
    return existing;
  }

  const limiter = new RateLimiter(identity);
  limiters.set(key, limiter);
  // Pruned after inserting, so the new entry is counted; it sits at the recent end, so it
  // is never a candidate for its own prune.
  pruneIdle();
  return limiter;
}

/**
 * Drop every shared bucket.
 *
 * For tests that need a known starting state; sharing is process-wide by design, so one
 * test's spent tokens would otherwise be another's problem.
 */
export function resetSharedRateLimiters(): void {
  limiters.clear();
  // The held cursor is state too: an iterator over a cleared Map is exhausted, so leaving it
  // in place would cost the next insertion a wasted sweep.
  pruneCursor = undefined;
}

/** Number of buckets currently held. Exposed for tests and diagnostics. */
export function sharedRateLimiterCount(): number {
  return limiters.size;
}

export default RateLimiter;
