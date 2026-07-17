/**
 * Deterministic coverage for the OUTBOUND rate limiter (src/utils/rateLimit.ts) and the
 * client wiring that spends it (src/api/client.ts).
 *
 * ## Why this exists
 *
 * The round-3 fix - one shared bucket per outbound identity, instead of one per
 * request-scoped `BookStackClient` - was justified with ad-hoc probes that were never
 * committed. With no test holding it, two live bypasses survived in the very code the
 * probes "proved": the registry keyed on the RAW `baseUrl`, so two spellings of one
 * upstream got two full buckets; and eviction dropped the least-recently-used LIVE bucket,
 * so an identity whose entry fell off the end was handed a brand-new full one while its
 * old waiters were still queued on the old object. Both are budget bypasses, and both were
 * invisible to a green suite. Everything below fails if either is reintroduced.
 *
 * ## How it is deterministic, and why it is instant
 *
 * A VIRTUAL CLOCK, extending the technique in tests/unit/retry.test.ts. There,
 * `globalThis.setTimeout` was replaced with one that records the requested delay and fires
 * immediately. That alone cannot work here: `RateLimiter.consumeToken()` re-reads the clock
 * after each sleep and loops until a token exists, so a timer that fires without time
 * passing spins forever. So `Date.now` is replaced too, and the fake `setTimeout` ADVANCES
 * it by exactly the delay it was asked to wait. Time only moves when the code under test
 * asks it to, which makes the token arithmetic exact rather than merely approximate: a test
 * can assert a nominal 60-second refill and still run in microseconds.
 *
 * Both globals are restored afterwards - `bun test` runs this file in the same process as
 * its neighbours.
 *
 * No BookStack, and no Docker. The two suites that need a real request stand up a local
 * `Bun.serve`, so the genuine axios stack, interceptors and limiter all run.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ErrorHandler } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';
import {
  canonicalBaseUrl,
  describeBaseUrl,
  getSharedRateLimiter,
  RateLimiter,
  type RateLimitIdentity,
  resetSharedRateLimiters,
  sharedRateLimiterCount,
} from '../../src/utils/rateLimit';

/** Mirrors MAX_IDLE_LIMITERS in src/utils/rateLimit.ts. */
const MAX_IDLE_LIMITERS = 256;

/** Mirrors PRUNE_SCAN_LIMIT in src/utils/rateLimit.ts: entries one insertion may examine. */
const PRUNE_SCAN_LIMIT = 64;

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

/* ------------------------------------------------------------------ virtual clock -- */

const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;
/** Every nominal wait the code under test asked for, in order. */
const waits: number[] = [];
let virtualNow = 0;

function installVirtualClock(): void {
  virtualNow = realDateNow();
  waits.length = 0;

  Date.now = () => virtualNow;
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    // Only real waits count. axios arms a 0 ms timer per request (follow-redirects does it
    // for `req.setTimeout(0)`), while every wait the limiter can compute is >= 1 ms, so the
    // filter separates the two cleanly - and a 0 ms timer must not move the clock.
    if (typeof ms === 'number' && ms > 0) {
      waits.push(ms);
      virtualNow += ms;
    }
    return realSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;
}

function uninstallVirtualClock(): void {
  globalThis.setTimeout = realSetTimeout;
  Date.now = realDateNow;
}

/* ---------------------------------------------------------------------- fixtures -- */

/** A complete identity, with only what a test cares about overridden. */
function identity(overrides: Partial<RateLimitIdentity> = {}): RateLimitIdentity {
  return {
    baseUrl: 'http://bucket.test/api',
    apiToken: 'identity-id:identity-secret',
    requestsPerMinute: 60,
    burstLimit: 10,
    ...overrides,
  };
}

/**
 * An identity whose bucket takes a minute of NOMINAL time to refill one token.
 *
 * `burstLimit: 1, requestsPerMinute: 1` is what makes the retention tests honest: a bucket
 * that has spent its only token stays non-idle for 60 seconds, so "the registry must not
 * evict a live bucket" cannot accidentally pass because the bucket refilled while the test
 * was running.
 */
function slowIdentity(index: number): RateLimitIdentity {
  return identity({
    apiToken: `slow-token-${index}`,
    requestsPerMinute: 1,
    burstLimit: 1,
  });
}

function testConfig(baseUrl: string, overrides: Partial<Config['rateLimit']> = {}): Config {
  return {
    // timeout 0 - i.e. no axios timeout - so the immediate-firing clock cannot abort a
    // request mid-flight.
    bookstack: { baseUrl, apiToken: 'client-test-id:client-test-secret', timeout: 0 },
    server: { name: 'bookstack-mcp-server-rate-limit-test', version: '1.0.0', port: 3000 },
    rateLimit: { requestsPerMinute: 60, burstLimit: 1, ...overrides },
    validation: { enabled: true, strictMode: true },
    logging: { level: 'error', format: 'pretty' },
    development: { nodeEnv: 'test', debug: false },
  };
}

function newClient(baseUrl: string, rateLimit?: Partial<Config['rateLimit']>): BookStackClient {
  return new BookStackClient(
    testConfig(baseUrl, rateLimit),
    noopLogger,
    new ErrorHandler(noopLogger)
  );
}

/* -------------------------------------------------------------- canonicalBaseUrl -- */

describe('canonicalBaseUrl', () => {
  it('collapses the spellings that denote one upstream', () => {
    const canonical = 'http://example.com/api';

    // Scheme case, host case, and the scheme's default port.
    expect(canonicalBaseUrl('http://example.com/api')).toBe(canonical);
    expect(canonicalBaseUrl('HTTP://EXAMPLE.COM:80/api')).toBe(canonical);
    expect(canonicalBaseUrl('http://Example.Com:80/api')).toBe(canonical);
    // Trailing slash: axios strips it when joining a request path, so it names no
    // different upstream.
    expect(canonicalBaseUrl('http://example.com/api/')).toBe(canonical);
    expect(canonicalBaseUrl('http://example.com/api///')).toBe(canonical);
    // Dot segments.
    expect(canonicalBaseUrl('http://example.com/x/../api')).toBe(canonical);
    expect(canonicalBaseUrl('http://example.com/./api')).toBe(canonical);
    // Percent-encoding of unreserved characters (RFC 3986 6.2.2.2). `URL` leaves these
    // alone, so without normalisation '/%61pi' would be a second identity for '/api'.
    expect(canonicalBaseUrl('http://example.com/%61pi')).toBe(canonical);
    expect(canonicalBaseUrl('HTTP://EXAMPLE.COM:80/%61pi/')).toBe(canonical);

    // https has a different default port, and must not fold onto http.
    expect(canonicalBaseUrl('HTTPS://EXAMPLE.COM:443/api/')).toBe('https://example.com/api');
    expect(canonicalBaseUrl('https://example.com/api')).not.toBe(canonical);
  });

  it('keeps genuinely different upstreams apart', () => {
    const distinct = [
      'http://example.com/api',
      'https://example.com/api',
      'http://example.com:8080/api',
      'http://other.example.com/api',
      // Path case is significant: a server may well route /api and /API differently.
      'http://example.com/API',
      'http://example.com/bookstack/api',
      'http://example.com',
    ].map((url) => canonicalBaseUrl(url));

    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it('is idempotent, so an already-canonical value may be passed back in', () => {
    for (const raw of [
      'HTTP://EXAMPLE.COM:80/%61pi/',
      'https://books.example.com:8443/api/',
      'http://127.0.0.1:6875/api',
      'http://[::1]:6875/api',
      'http://example.com',
      // A stray '%' that is not a valid triplet must survive untouched, and identically
      // on a second pass.
      'http://example.com/a%zz',
    ]) {
      const once = canonicalBaseUrl(raw);
      expect(canonicalBaseUrl(once)).toBe(once);
    }
  });

  it('preserves the port, host and path a request actually needs', () => {
    expect(canonicalBaseUrl('http://127.0.0.1:6875/api')).toBe('http://127.0.0.1:6875/api');
    expect(canonicalBaseUrl('https://books.example.com:8443/api')).toBe(
      'https://books.example.com:8443/api'
    );
    expect(canonicalBaseUrl('http://[::1]:6875/api')).toBe('http://[::1]:6875/api');
    expect(canonicalBaseUrl('http://example.com')).toBe('http://example.com');
  });

  it('refuses what it cannot safely collapse', () => {
    // Not a URL at all. `x-bookstack-url` is caller-supplied and never sees the config
    // schema, so this is the check that stands between a header and axios.
    expect(() => canonicalBaseUrl('not a url')).toThrow(/not a valid absolute URL/);
    expect(() => canonicalBaseUrl('')).toThrow(/not a valid absolute URL/);
    expect(() => canonicalBaseUrl('/api')).toThrow(/not a valid absolute URL/);

    // Schemes this client cannot speak.
    expect(() => canonicalBaseUrl('file:///etc/passwd')).toThrow(/http or https scheme/);
    expect(() => canonicalBaseUrl('ftp://example.com/api')).toThrow(/http or https scheme/);

    // Userinfo: free text on the identity, i.e. an unbounded supply of aliases for one
    // upstream - and a credential in a field that gets logged.
    expect(() => canonicalBaseUrl('http://alice:secret@example.com/api')).toThrow(/userinfo/);
    expect(() => canonicalBaseUrl('http://alice@example.com/api')).toThrow(/userinfo/);

    // Query and fragment: same alias problem, and meaningless on a base URL.
    expect(() => canonicalBaseUrl('http://example.com/api?x=1')).toThrow(/query string/);
    expect(() => canonicalBaseUrl('http://example.com/api#frag')).toThrow(/query string/);
  });

  it('does not echo a URL password in the error it raises about it', () => {
    // The refusal must not become the leak. Reporting the offending value verbatim is the
    // obvious way to write this function and would put the credential in the operator's log.
    const error = (() => {
      try {
        canonicalBaseUrl('http://alice:url-password-marker@example.com/api');
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error).toBeDefined();
    expect(error?.message).not.toContain('url-password-marker');
    expect(error?.message).not.toContain('alice');
  });

  it('never echoes the refused value, wherever the secret was spelled', async () => {
    // R5-W2, at its root. Every refusal above is about a URL somebody supplied, and quoting
    // it - the obvious way to write the message - is how the refusal becomes the leak. This
    // one reached an unauthenticated caller: ConfigSchema accepted a base URL with a query
    // string, so the process listened, and the first GET /health built the client, hit the
    // refusal and returned `BookStack base URL 'https://books.example/api?api_token=…' must
    // not carry a query string…` verbatim to anyone who could reach the port.
    //
    // WHY THE VECTORS BELOW CHANGED, AND WHAT THE OLD ONES COULD NOT SEE. R5-W2's fix kept
    // "the three components that can never hold a credential - scheme, host and path", and
    // this test was written to match: every marker went into userinfo, a query or a
    // fragment, and every URL used a harmless `/api` path. So it proved those three
    // components are dropped, and was structurally incapable of noticing that the rest of
    // the value was still being quoted. R6-W3: a path is arbitrary text chosen by whoever
    // deployed the instance, and `https://books.example/<proxy capability>/api?x=1` echoed
    // the capability verbatim out of the branch complaining about the QUERY.
    //
    // So each vector now carries its marker in a component the refusal is NOT about, and
    // the assertion is the general one the fix actually makes: a refusal interpolates
    // nothing at all.
    const refusals = [
      // The original three: the marker is in the component being refused.
      { url: 'https://svc:userinfo-marker@books.example/api', marker: 'userinfo-marker' },
      { url: 'https://books.example/api?api_token=query-marker', marker: 'query-marker' },
      { url: 'https://books.example/api#fragment-marker', marker: 'fragment-marker' },
      // A scheme this client cannot speak, still carrying a credential.
      { url: 'ftp://svc:scheme-marker@books.example/api', marker: 'scheme-marker' },
      // R6-W3: the marker is in the PATH and the violation is somewhere else entirely.
      // Each of these leaks on the pre-R6 code, which quoted scheme://host/path.
      {
        url: 'https://books.example/path-credential-marker/api?invalid=1',
        marker: 'path-credential-marker',
      },
      {
        url: 'https://svc:pw@books.example/path-userinfo-marker/api',
        marker: 'path-userinfo-marker',
      },
      {
        url: 'https://books.example/path-fragment-marker/api#frag',
        marker: 'path-fragment-marker',
      },
      // The host is a URL component like any other. Nothing parsed may be quoted, so a
      // tenant-identifying hostname must not come back either.
      { url: 'https://host-marker.books.example/api?x=1', marker: 'host-marker' },
    ];

    for (const { url, marker } of refusals) {
      expect(() => canonicalBaseUrl(url)).toThrow();

      const message = (() => {
        try {
          canonicalBaseUrl(url);
          return '';
        } catch (caught) {
          return (caught as Error).message;
        }
      })();

      expect(message, `${marker} must not appear in the refusal`).not.toContain(marker);
      // The message is still about a URL the operator can identify.
      expect(message).toContain('BookStack base URL');
    }
  });

  /**
   * The other half, or "quote nothing" is satisfied by `throw new Error('no')`.
   *
   * An operator who mistypes BOOKSTACK_BASE_URL has to learn two things from the refusal:
   * which setting is wrong, and what is wrong with it. Both are recoverable from a message
   * that interpolates nothing, because the setting is named and the offending COMPONENT is
   * named - and the value itself is already in front of them, in their own environment.
   */
  it('still tells the operator which setting is wrong and which component offended', () => {
    const messageFor = (url: string): string => {
      try {
        canonicalBaseUrl(url);
        return '';
      } catch (caught) {
        return (caught as Error).message;
      }
    };

    // Userinfo, with a path marker riding along: named component, no components quoted.
    const userinfo = messageFor('https://svc:pw@books.example/deploy-marker/api');
    expect(userinfo).toContain('BookStack base URL');
    expect(userinfo).toContain('userinfo');
    expect(userinfo).not.toContain('deploy-marker');

    const query = messageFor('https://books.example/deploy-marker/api?x=1');
    expect(query).toContain('BookStack base URL');
    expect(query).toContain('query string or fragment');
    expect(query).not.toContain('deploy-marker');

    const scheme = messageFor('ftp://books.example/deploy-marker/api');
    expect(scheme).toContain('BookStack base URL');
    expect(scheme).toContain('http or https scheme');
    expect(scheme).not.toContain('deploy-marker');

    // Not a URL at all: nothing parsed, so there is not even a component to name - but the
    // setting still is, and an example of the right shape is given.
    const junk = messageFor('deploy-marker-not-a-url');
    expect(junk).toContain('BookStack base URL');
    expect(junk).toContain('not a valid absolute URL');
    expect(junk).not.toContain('deploy-marker');
  });
});

/* ------------------------------------------------ describing a base URL for a log -- */

/**
 * R6-W3's other surface: the base URL that is ACCEPTED, and then written to the log at
 * startup at `info`.
 *
 * The redaction rules cannot help here, and that is the point. A URL under an allowlisted
 * key is sanitized structurally - userinfo dropped, sensitive query values replaced - and
 * the path is deliberately KEPT, because `/books/5` is what makes a request line worth
 * reading. Applied to a base URL that reasoning inverts: the path is the one part the
 * operator supplied, and a reverse-proxy capability lives exactly there. So the fix is not
 * a redaction rule, it is not rendering the URL.
 */
describe('describeBaseUrl', () => {
  it('reports the origin and spells out a path only when it is a known constant', () => {
    // The overwhelmingly common deployments, which lose nothing at all: an operator reads
    // the same '/api' they always did.
    expect(describeBaseUrl('https://books.example.com/api')).toEqual({
      base_origin: 'https://books.example.com',
      base_path_segments: 1,
      base_path: '/api',
    });

    expect(describeBaseUrl('http://127.0.0.1:6875/api')).toEqual({
      base_origin: 'http://127.0.0.1:6875',
      base_path_segments: 1,
      base_path: '/api',
    });

    // No path at all is also a constant, and says so rather than digesting the empty string.
    expect(describeBaseUrl('https://books.example.com')).toEqual({
      base_origin: 'https://books.example.com',
      base_path_segments: 0,
      base_path: '',
    });
  });

  it('digests a path it does not recognise instead of printing it', () => {
    const marker = 'proxy-capability-marker';
    const described = describeBaseUrl(`https://books.example.com/${marker}/api`);

    // THE CLAIM: the arbitrary part of the value is not in the description, under any key.
    expect(JSON.stringify(described)).not.toContain(marker);

    // THE OTHER CLAIM: the description still identifies the upstream and the shape of its
    // mount, which is what the startup line is for.
    expect(described.base_origin).toBe('https://books.example.com');
    expect(described.base_path_segments).toBe(2);
    expect(described.base_path).toBeUndefined();
    expect(described.base_path_digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('gives the same digest for the same path and a different one otherwise', () => {
    // What the digest is FOR: an operator comparing today's startup line with yesterday's,
    // or hashing their own configured path to confirm which one is live.
    const first = describeBaseUrl('https://books.example.com/mount/api');
    const same = describeBaseUrl('https://books.example.com/mount/api');
    const other = describeBaseUrl('https://books.example.com/other/api');

    expect(first.base_path_digest).toBe(same.base_path_digest);
    expect(first.base_path_digest).not.toBe(other.base_path_digest);
  });

  it('describes a value it cannot parse rather than throwing', () => {
    // Unreachable from the running server - ConfigSchema and BookStackClient both refuse
    // such a value first - which is exactly why it must not depend on being unreachable. A
    // logging helper that throws turns a log line into an outage.
    expect(describeBaseUrl('not a url at all')).toEqual({
      base_origin: '[unusable base URL]',
      base_path_segments: 0,
    });
    expect(describeBaseUrl('https://svc:secret-marker@books.example/api')).toEqual({
      base_origin: '[unusable base URL]',
      base_path_segments: 0,
    });
  });
});

/* ---------------------------------------------------------- the identity registry -- */

describe('shared limiter registry: identity', () => {
  beforeEach(() => {
    resetSharedRateLimiters();
  });

  afterAll(() => {
    resetSharedRateLimiters();
  });

  it('hands one identity the same bucket every time', () => {
    const first = getSharedRateLimiter(identity());

    expect(getSharedRateLimiter(identity())).toBe(first);
    expect(sharedRateLimiterCount()).toBe(1);
  });

  it('hands equivalent URL spellings ONE bucket', () => {
    // R4-W1(1). The registry hashed the raw string, so these were two full buckets for one
    // BookStack - an authenticated caller could recover the whole burst allowance just by
    // changing how it spelled `x-bookstack-url`.
    const canonical = getSharedRateLimiter(identity({ baseUrl: 'http://example.com/api' }));

    for (const alias of [
      'HTTP://EXAMPLE.COM:80/api',
      'http://Example.COM:80/api/',
      'http://example.com/x/../api',
      'http://example.com/%61pi',
    ]) {
      expect(getSharedRateLimiter(identity({ baseUrl: alias }))).toBe(canonical);
    }

    expect(sharedRateLimiterCount()).toBe(1);
  });

  it('keeps distinct tokens on the same upstream isolated', () => {
    // One BookStack, two API tokens: two budgets upstream, so two buckets here. They must
    // not be able to throttle each other.
    const alice = getSharedRateLimiter(identity({ apiToken: 'alice-id:alice-secret' }));
    const bob = getSharedRateLimiter(identity({ apiToken: 'bob-id:bob-secret' }));

    expect(alice).not.toBe(bob);
    expect(sharedRateLimiterCount()).toBe(2);
  });

  it('keeps distinct upstreams isolated', () => {
    const first = getSharedRateLimiter(identity({ baseUrl: 'http://one.example.com/api' }));
    const second = getSharedRateLimiter(identity({ baseUrl: 'http://two.example.com/api' }));
    const port = getSharedRateLimiter(identity({ baseUrl: 'http://one.example.com:8080/api' }));
    const scheme = getSharedRateLimiter(identity({ baseUrl: 'https://one.example.com/api' }));

    expect(new Set([first, second, port, scheme]).size).toBe(4);
  });

  it("does not let one identity inherit another's limits", () => {
    // A bucket built for burstLimit=1 is not the bucket a burstLimit=10 client asked for;
    // handing over the first would make the effective limits depend on arrival order.
    const strict = getSharedRateLimiter(identity({ burstLimit: 1 }));
    const loose = getSharedRateLimiter(identity({ burstLimit: 10 }));
    const slow = getSharedRateLimiter(identity({ requestsPerMinute: 6 }));

    expect(new Set([strict, loose, slow]).size).toBe(3);
  });

  it('cannot be confused by fields that run into each other', () => {
    // The digest joins four fields. `x-bookstack-token` is caller-supplied, so if the
    // separator were anything a header can carry, a token could impersonate a boundary.
    const a = getSharedRateLimiter(
      identity({ baseUrl: 'http://example.com/api', apiToken: 'tok', requestsPerMinute: 60 })
    );
    const b = getSharedRateLimiter(
      identity({ baseUrl: 'http://example.com/api', apiToken: 'tok 60', requestsPerMinute: 1 })
    );
    const c = getSharedRateLimiter(
      identity({ baseUrl: 'http://example.com/api', apiToken: 'tok\t60', requestsPerMinute: 1 })
    );

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('refuses an unusable base URL rather than bucketing it', () => {
    expect(() => getSharedRateLimiter(identity({ baseUrl: 'not a url' }))).toThrow(
      /not a valid absolute URL/
    );
    expect(() => getSharedRateLimiter(identity({ baseUrl: 'file:///etc/passwd' }))).toThrow(
      /http or https scheme/
    );
    expect(sharedRateLimiterCount()).toBe(0);
  });
});

/* --------------------------------------------------------- retention and eviction -- */

describe('shared limiter registry: retention', () => {
  beforeAll(() => {
    installVirtualClock();
  });

  afterAll(() => {
    uninstallVirtualClock();
    resetSharedRateLimiters();
  });

  beforeEach(() => {
    resetSharedRateLimiters();
    waits.length = 0;
  });

  it('prunes an idle bucket to stay at the retention target', () => {
    // An idle bucket is full and unqueued, so dropping it is a no-op: the bucket rebuilt
    // for it later would grant exactly the same allowance. That is the ONLY safe candidate.
    for (let i = 0; i < MAX_IDLE_LIMITERS; i++) {
      getSharedRateLimiter(identity({ apiToken: `idle-${i}` }));
    }
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);

    getSharedRateLimiter(identity({ apiToken: 'the-new-one' }));

    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);
  });

  it('prunes least-recently-used first, and a hit refreshes recency', () => {
    // Inserted first, so these are the two oldest entries.
    const oldest = getSharedRateLimiter(identity({ apiToken: 'idle-0' }));
    const secondOldest = getSharedRateLimiter(identity({ apiToken: 'idle-1' }));
    for (let i = 2; i < MAX_IDLE_LIMITERS; i++) {
      getSharedRateLimiter(identity({ apiToken: `idle-${i}` }));
    }
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);

    // Touch the oldest entry: it must move to the recent end, putting `idle-1` at the front.
    expect(getSharedRateLimiter(identity({ apiToken: 'idle-0' }))).toBe(oldest);

    getSharedRateLimiter(identity({ apiToken: 'the-new-one' }));
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);

    // The refreshed entry survived...
    expect(getSharedRateLimiter(identity({ apiToken: 'idle-0' }))).toBe(oldest);
    // ...and the one that was then least recently used is the one that went.
    expect(getSharedRateLimiter(identity({ apiToken: 'idle-1' }))).not.toBe(secondOldest);
  });

  it('NEVER replaces a live bucket, even when every entry is live', async () => {
    // R4-W1(2), and the sharpest test in this file.
    //
    // Fill the registry with buckets that have spent their only token. Under the old
    // policy, inserting one more identity evicted the least-recently-used LIVE bucket, so
    // looking that identity up again returned a different object with a full allowance -
    // while the evicted bucket's own waiters carried on queueing against the old one. The
    // registry stayed at its cap and the caller got its burst twice.
    const spent: RateLimiter[] = [];
    for (let i = 0; i < MAX_IDLE_LIMITERS; i++) {
      const limiter = getSharedRateLimiter(slowIdentity(i));
      await limiter.acquire(); // its only token; refilling one back takes 60 nominal seconds
      spent.push(limiter);
    }

    expect(spent.every((limiter) => !limiter.isIdle())).toBe(true);
    expect(waits).toEqual([]); // nothing queued: each took a token that was there

    // The 257th identity. There is nothing safe to prune, so the map is allowed to exceed
    // the retention target rather than mint capacity.
    getSharedRateLimiter(slowIdentity(MAX_IDLE_LIMITERS));
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS + 1);

    // The identity that the old policy would have evicted: same object, still exhausted.
    const first = getSharedRateLimiter(slowIdentity(0));
    expect(first).toBe(spent[0]);
    expect(first.getTokenCount()).toBe(0);
    expect(first.canMakeRequest()).toBe(false);

    // And it genuinely still costs a wait to use, rather than merely reporting one.
    await first.acquire();
    expect(waits).toEqual([60_000]);
  });

  it('reclaims idle garbage sitting BEHIND a live prefix', async () => {
    // R5-W1, and the gap between the two tests either side of it: one fills the front with
    // idle entries, the other fills the whole map with live ones. Neither has a live prefix
    // with garbage behind it, which is the ordering an adversary picks.
    //
    // The bounded scan used to restart from the front of the map on every insertion, and
    // nothing ever removes a live entry, so the first PRUNE_SCAN_LIMIT live buckets were
    // rescanned and skipped forever and the scan never reached the idle entries behind them.
    // An authenticated caller could hold a small prefix busy while rotating
    // `x-bookstack-token` identities behind it: no minted capacity, but the garbage bound
    // was advertised and not delivered. Codex's probe ended at 356 entries, not 256.
    const live: RateLimiter[] = [];
    for (let i = 0; i < PRUNE_SCAN_LIMIT; i++) {
      const limiter = getSharedRateLimiter(slowIdentity(i));
      await limiter.acquire(); // its only token: 60 nominal seconds until it is idle again
      live.push(limiter);
    }
    // The premise: the prefix the scan starts on is entirely non-idle, and stays that way
    // for the whole test - the virtual clock only advances when the code under test sleeps.
    expect(live.every((limiter) => !limiter.isIdle())).toBe(true);

    // Idle garbage, all of it behind that prefix.
    for (let i = PRUNE_SCAN_LIMIT; i < MAX_IDLE_LIMITERS; i++) {
      getSharedRateLimiter(identity({ apiToken: `idle-${i}` }));
    }
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);

    // Now rotate identities, exactly as a caller cycling `x-bookstack-token` would.
    for (let i = 0; i < 100; i++) {
      getSharedRateLimiter(identity({ apiToken: `rotated-${i}` }));
    }

    // Bounded scans that make progress get back to the target; scans that restart from the
    // front do not - this is 356 with the front-only scan.
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);

    // ...and NOT by reaching the target the forbidden way. Every live bucket is still the
    // same object, still exhausted: no waiter was stranded and nobody was minted a refill.
    for (let i = 0; i < PRUNE_SCAN_LIMIT; i++) {
      const again = getSharedRateLimiter(slowIdentity(i));
      expect(again).toBe(live[i] as RateLimiter);
      expect(again.getTokenCount()).toBe(0);
    }
    expect(waits).toEqual([]);
  });

  it('prunes the live entries it had to keep, once they fall idle again', async () => {
    // The flip side of the test above, and what makes overshooting the target a temporary
    // state rather than a leak: a bucket is live only until it refills, after which it is
    // as prunable as any other. Without this, "never evict a live bucket" would just be
    // unbounded growth with a nicer name.
    for (let i = 0; i < MAX_IDLE_LIMITERS; i++) {
      await getSharedRateLimiter(slowIdentity(i)).acquire();
    }
    getSharedRateLimiter(slowIdentity(MAX_IDLE_LIMITERS));
    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS + 1);

    // Every spent bucket refills its one token and is now indistinguishable from a fresh
    // one, so the registry may reclaim them.
    virtualNow += 60_000;

    getSharedRateLimiter(slowIdentity(MAX_IDLE_LIMITERS + 1));

    expect(sharedRateLimiterCount()).toBe(MAX_IDLE_LIMITERS);
  });
});

/* --------------------------------------------------------------- the bucket itself -- */

describe('RateLimiter', () => {
  beforeAll(() => {
    installVirtualClock();
  });

  afterAll(() => {
    uninstallVirtualClock();
  });

  beforeEach(() => {
    waits.length = 0;
  });

  it('serves a burst immediately and then waits for the refill', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60, burstLimit: 3 });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([]);
    expect(limiter.getTokenCount()).toBe(0);

    // 60/min = one token per second, and the bucket is empty.
    await limiter.acquire();
    expect(waits).toEqual([1000]);
  });

  it('serialises simultaneous acquisition so the bucket is never overdrawn', async () => {
    // The regression: N callers arriving together at an empty bucket each computed the same
    // wait from the same reading, all woke together and all decremented, so the count went
    // negative and N requests left for a budget of one.
    const limiter = new RateLimiter({ requestsPerMinute: 60, burstLimit: 3 });
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map(async (index) => {
        await limiter.acquire();
        order.push(index);
      })
    );

    // Three had tokens waiting; the last two each paid a full second of nominal refill.
    expect(waits).toEqual([1000, 1000]);
    // Served in arrival order: no late arrival overtook a waiter and spent its token.
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.getTokenCount()).toBe(0);
    expect(limiter.getTokenCount()).toBeGreaterThanOrEqual(0);
  });

  it('refills at the configured rate, capped at the burst limit', () => {
    const limiter = new RateLimiter({ requestsPerMinute: 120, burstLimit: 4 });

    virtualNow += 60_000;

    // Two per second for a minute is 120 tokens' worth of refill, but the bucket holds 4.
    expect(limiter.getTokenCount()).toBe(4);
  });

  it('reports idleness only when a fresh bucket would be indistinguishable', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 60, burstLimit: 2 });
    expect(limiter.isIdle()).toBe(true);

    await limiter.acquire();
    // Spent a token: a replacement would NOT grant the same allowance, so not idle.
    expect(limiter.isIdle()).toBe(false);

    virtualNow += 1_000;
    expect(limiter.isIdle()).toBe(true);
  });

  it('is not idle while a caller is queued on it', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 1, burstLimit: 1 });
    await limiter.acquire();

    const queued = limiter.acquire();
    // Waiters alone disqualify it: evicting this bucket would strand them on an object the
    // registry no longer knows about, while the next lookup built a fresh full one.
    expect(limiter.isIdle()).toBe(false);
    expect(limiter.canMakeRequest()).toBe(false);

    await queued;
    expect(waits).toEqual([60_000]);
  });

  it('keeps separate buckets from throttling each other', async () => {
    const mine = new RateLimiter({ requestsPerMinute: 60, burstLimit: 1 });
    const theirs = new RateLimiter({ requestsPerMinute: 60, burstLimit: 1 });

    await mine.acquire();
    await theirs.acquire();

    expect(waits).toEqual([]);
  });
});

/* ------------------------------------------------- request-scoped clients, over HTTP -- */

/** A stub upstream that answers every request 200 and counts what arrived. */
interface Upstream {
  baseUrl: string;
  paths: string[];
  stop(): void;
}

function startUpstream(): Upstream {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request: Request): Response {
      paths.push(new URL(request.url).pathname);
      return new Response(JSON.stringify({ data: [], total: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/api`,
    paths,
    stop: () => server.stop(true),
  };
}

describe('request-scoped clients share one bucket', () => {
  let upstream: Upstream;

  beforeAll(() => {
    upstream = startUpstream();
    installVirtualClock();
  });

  afterAll(() => {
    uninstallVirtualClock();
    upstream.stop();
    resetSharedRateLimiters();
  });

  beforeEach(() => {
    resetSharedRateLimiters();
    waits.length = 0;
    upstream.paths.length = 0;
  });

  it('makes a second client queue behind the first, sequentially', async () => {
    // R3-W2. `POST /message` builds a fresh BookStackMCPServer - and so a fresh
    // BookStackClient - per request. When the bucket belonged to the client, every RPC
    // started full and the configured limit bounded nothing at all.
    const first = newClient(upstream.baseUrl, { burstLimit: 1, requestsPerMinute: 60 });
    const second = newClient(upstream.baseUrl, { burstLimit: 1, requestsPerMinute: 60 });

    await first.listBooks();
    expect(waits).toEqual([]); // the burst allowance, spent

    await second.listBooks();

    // A separate object, a separate request - and it still paid for the bucket the first
    // one emptied. With a per-client bucket this is [].
    expect(waits).toEqual([1000]);
    expect(upstream.paths).toEqual(['/api/books', '/api/books']);
  });

  it('makes simultaneous clients queue, rather than each getting a private burst', async () => {
    // The concurrent form of the same bug, where the overshoot scaled with concurrency.
    const clients = [0, 1, 2].map(() =>
      newClient(upstream.baseUrl, { burstLimit: 1, requestsPerMinute: 60 })
    );

    await Promise.all(clients.map((client) => client.listBooks()));

    expect(waits).toEqual([1000, 1000]);
    expect(upstream.paths).toHaveLength(3);
  });

  it('makes clients spelling the upstream differently share one bucket', async () => {
    // R4-W1(1) at the level it actually bites: `x-bookstack-url` reaches this constructor,
    // so a caller that varied the spelling got a fresh full bucket per request.
    const canonical = newClient(upstream.baseUrl, { burstLimit: 1, requestsPerMinute: 60 });
    const aliased = newClient(upstream.baseUrl.replace('http://', 'HTTP://').concat('/'), {
      burstLimit: 1,
      requestsPerMinute: 60,
    });
    const dotted = newClient(upstream.baseUrl.replace('/api', '/x/../%61pi'), {
      burstLimit: 1,
      requestsPerMinute: 60,
    });

    await canonical.listBooks();
    await aliased.listBooks();
    await dotted.listBooks();

    // One bucket between all three spellings: two of the three had to wait for a refill.
    expect(waits).toEqual([1000, 1000]);
    expect(sharedRateLimiterCount()).toBe(1);
    // And the canonical URL is what axios uses, so every alias still reaches the real path.
    expect(upstream.paths).toEqual(['/api/books', '/api/books', '/api/books']);
  });

  it('gives a client with a different token its own bucket', async () => {
    const mine = newClient(upstream.baseUrl, { burstLimit: 1, requestsPerMinute: 60 });
    const theirs = new BookStackClient(
      {
        ...testConfig(upstream.baseUrl, { burstLimit: 1, requestsPerMinute: 60 }),
        bookstack: {
          baseUrl: upstream.baseUrl,
          apiToken: 'someone-else-id:someone-else-secret',
          timeout: 0,
        },
      },
      noopLogger,
      new ErrorHandler(noopLogger)
    );

    await mine.listBooks();
    await theirs.listBooks();

    // Two credentials, two upstream budgets: neither may spend the other's.
    expect(waits).toEqual([]);
    expect(sharedRateLimiterCount()).toBe(2);
  });

  it('refuses to build a client on an unusable base URL', () => {
    // `x-bookstack-url` is merged straight into a Partial<Config> by the /message handler
    // and never sees the config schema, so this constructor is where it is validated.
    expect(() => newClient('not a url')).toThrow(/not a valid absolute URL/);
    expect(() => newClient('http://alice:secret@example.com/api')).toThrow(/userinfo/);
    expect(() => newClient('file:///etc/passwd')).toThrow(/http or https scheme/);
  });
});
