/**
 * Deterministic coverage for `BookStackClient`'s retry policy (src/api/client.ts,
 * `requestWithRetry` / `isReplayable` / `retryDelayMs`) and the header parsing it
 * leans on (src/utils/errors.ts, `extractRetryInfo`).
 *
 * ## Why this exists
 *
 * Nothing else can fail on any of this. The live fixture raises BookStack's throttle
 * to 5000/min precisely so the retry path never fires, and the integration helpers do
 * their own unrelated retrying. A regression that replayed a mutating request after a
 * 5xx, ignored `Retry-After`, or blew the total-wait budget would leave every other
 * suite green.
 *
 * ## How it is deterministic, and why it is instant
 *
 * Two stubs, no mocks of the code under test:
 *
 *  1. A local `Bun.serve` speaks real HTTP, so the real axios stack, the real
 *     interceptors and the real `ErrorHandler` all run. Each test scripts the status
 *     and headers per attempt and then counts the attempts that actually arrived -
 *     the only honest way to prove "retried" vs "not retried".
 *  2. `globalThis.setTimeout` is replaced for the duration of this file with one that
 *     RECORDS the requested delay and fires the callback immediately. `sleep()` in
 *     client.ts resolves `setTimeout` off the global at call time, so every retry wait
 *     is captured rather than served: a test can assert an exact 30-second wait and
 *     still run in milliseconds.
 *
 * The recorded delay is also what the budget arithmetic uses - `requestWithRetry` does
 * `waitedMs += delay` with the nominal value, never a measured one - so the total-wait
 * budget is exercised exactly as it would be in production, at zero wall-clock cost.
 *
 * Only waits > 0 are recorded. `axios` hands the socket a `req.setTimeout(0)` per
 * request (follow-redirects arms a 0 ms timer for it), while every wait the retry loop
 * can compute is at least 250 ms, so the filter separates the two cleanly.
 *
 * `bookstack.timeout` is 0 - i.e. no axios timeout - so the immediate-firing clock
 * cannot abort a request mid-flight, and no timer other than the retry loop's own is
 * in play.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ErrorHandler } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';

/** The retry policy's own constants, mirrored here so the bounds can be asserted. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const JITTER_RATIO = 0.25;
const MAX_TOTAL_WAIT_MS = 30_000;
/** `retryDelayMs` adds this settling margin to every server-directed wait. */
const SETTLING_MARGIN_MS = 250;
/** `ErrorHandler` refuses to believe a server-directed wait longer than this. */
const MAX_SERVER_DIRECTED_WAIT_MS = 600_000;

/** Statuses `ErrorHandler.isRetryable()` treats as transient. */
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504] as const;

/** One scripted answer from the stub. */
interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One request as the stub actually received it. */
interface RecordedRequest {
  method: string;
  path: string;
  contentType: string | null;
  /** Raw bytes: multipart bodies carry binary that a utf8 decode would mangle. */
  body: Buffer;
}

interface Stub {
  baseUrl: string;
  /** Every request that arrived, in order. */
  requests: RecordedRequest[];
  /** Answer for attempt 1, 2, ...; any further attempt gets `fallback`. */
  plan: StubResponse[];
  /** Answer once `plan` runs out. Also what an unexpected extra attempt receives. */
  fallback: StubResponse;
  reset(): void;
  stop(): void;
}

function startStub(): Stub {
  const requests: RecordedRequest[] = [];

  const stub: Stub = {
    baseUrl: '',
    requests,
    plan: [],
    fallback: { status: 200, body: { unplanned: true } },
    reset() {
      requests.length = 0;
      stub.plan = [];
      stub.fallback = { status: 200, body: { unplanned: true } };
    },
    stop() {
      server.stop(true);
    },
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        contentType: req.headers.get('content-type'),
        body: Buffer.from(await req.arrayBuffer()),
      });

      const spec = stub.plan[requests.length - 1] ?? stub.fallback;
      return new Response(JSON.stringify(spec.body ?? {}), {
        status: spec.status,
        headers: { 'Content-Type': 'application/json', ...spec.headers },
      });
    },
  });

  stub.baseUrl = `http://localhost:${server.port}/api`;
  return stub;
}

/**
 * The retry loop is private, and deliberately so - `REPLAY_SAFE_METHODS` lists HEAD and
 * OPTIONS, which no public method on the client ever issues. Reaching it directly is the
 * only way to prove those two verbs are treated as replayable; everything else drives the
 * real public methods, so the wiring is covered too.
 */
interface RetryDriver {
  requestWithRetry<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
}

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

/** Fires every timer immediately, recording what it was asked to wait for. */
const realSetTimeout = globalThis.setTimeout;
const waits: number[] = [];

/** An HTTP-date `secondsAhead` seconds from now, in the format RFC 9110 mandates. */
function httpDate(secondsAhead: number): string {
  return new Date(Date.now() + secondsAhead * 1000).toUTCString();
}

/** Normalise a multipart body for comparison: the boundary is random per attempt. */
function multipartWithoutBoundary(request: RecordedRequest): string {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(request.contentType ?? '')?.[2];
  if (!boundary) {
    throw new Error(`Expected a multipart boundary, got Content-Type: ${request.contentType}`);
  }
  // latin1 is byte-preserving, so binary parts survive the comparison intact.
  return request.body.toString('latin1').split(boundary).join('<boundary>');
}

describe('BookStackClient retry policy', () => {
  let stub: Stub;
  let client: BookStackClient;
  let driver: RetryDriver;

  beforeAll(() => {
    stub = startStub();

    const config: Config = {
      bookstack: { baseUrl: stub.baseUrl, apiToken: 'retry-test-id:retry-test-secret', timeout: 0 },
      server: { name: 'bookstack-mcp-server-retry-test', version: '1.0.0', port: 3000 },
      // Wide enough that the client-side limiter never sleeps: the waits under test
      // must be the retry loop's own.
      rateLimit: { requestsPerMinute: 60_000, burstLimit: 10_000 },
      validation: { enabled: true, strictMode: true },
      logging: { level: 'error', format: 'pretty' },
      development: { nodeEnv: 'test', debug: false },
    };

    client = new BookStackClient(config, noopLogger, new ErrorHandler(noopLogger));
    driver = client as unknown as RetryDriver;

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (typeof ms === 'number' && ms > 0) {
        waits.push(ms);
      }
      return realSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;
  });

  afterAll(() => {
    globalThis.setTimeout = realSetTimeout;
    stub.stop();
  });

  beforeEach(() => {
    stub.reset();
    waits.length = 0;
  });

  describe('429: rejected before the route runs, so any verb may be replayed', () => {
    it('retries a safe verb (GET) and returns the eventual success', async () => {
      stub.plan = [
        { status: 429, headers: { 'Retry-After': '1' }, body: { error: { message: 'slow down' } } },
        { status: 200, body: { data: [{ id: 7, name: 'W6' }], total: 1 } },
      ];

      const result = await client.listBooks();

      expect(stub.requests).toHaveLength(2);
      expect(stub.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
      // The caller sees the second attempt's body, not the 429.
      expect(result.total).toBe(1);
      expect(result.data.map((book) => book.id)).toEqual([7]);
    });

    it('retries a mutating verb (POST), re-sending the identical body', async () => {
      stub.plan = [
        { status: 429, headers: { 'Retry-After': '0' }, body: { error: { message: 'slow down' } } },
        { status: 200, body: { id: 12, name: 'Created after a 429' } },
      ];

      const result = await client.createBook({ name: 'Created after a 429' });

      expect(stub.requests).toHaveLength(2);
      expect(stub.requests.map((request) => request.method)).toEqual(['POST', 'POST']);
      // The replay must carry the payload again - not an empty second attempt.
      for (const request of stub.requests) {
        expect(JSON.parse(request.body.toString('utf8'))).toEqual({ name: 'Created after a 429' });
      }
      expect(result.id).toBe(12);
      expect(result.name).toBe('Created after a 429');
    });

    it('retries the other mutating verbs (PUT, DELETE)', async () => {
      stub.plan = [
        { status: 429, headers: { 'Retry-After': '0' }, body: { error: { message: 'slow down' } } },
        { status: 200, body: { id: 3, name: 'Updated' } },
      ];
      await client.updateBook(3, { name: 'Updated' });
      expect(stub.requests.map((request) => request.method)).toEqual(['PUT', 'PUT']);

      stub.reset();
      stub.plan = [
        { status: 429, headers: { 'Retry-After': '0' }, body: { error: { message: 'slow down' } } },
        { status: 200, body: {} },
      ];
      await client.deleteBook(3);
      expect(stub.requests.map((request) => request.method)).toEqual(['DELETE', 'DELETE']);
    });
  });

  describe('5xx: the request reached the application, so only safe verbs are replayed', () => {
    for (const status of RETRYABLE_STATUSES.filter((code) => code !== 429)) {
      it(`retries GET after ${status}`, async () => {
        stub.plan = [{ status, body: { error: { message: 'upstream is unwell' } } }];
        stub.fallback = { status: 200, body: { data: [], total: 0 } };

        const result = await client.listBooks();

        expect(stub.requests).toHaveLength(2);
        expect(result).toEqual({ data: [], total: 0 });
      });
    }

    // HEAD and OPTIONS are in REPLAY_SAFE_METHODS but are issued by no public method;
    // see RetryDriver above for why this reaches the private loop.
    for (const method of ['HEAD', 'OPTIONS']) {
      it(`retries ${method} after 503`, async () => {
        stub.plan = [{ status: 503, body: { error: { message: 'unavailable' } } }];
        stub.fallback = { status: 200, body: { ok: true } };

        const response = await driver.requestWithRetry<unknown>({ method, url: '/books' });

        expect(response.status).toBe(200);
        expect(stub.requests).toHaveLength(2);
        expect(stub.requests.map((request) => request.method)).toEqual([method, method]);
      });
    }

    const writes: { verb: string; call: () => Promise<unknown> }[] = [
      { verb: 'POST', call: () => client.createBook({ name: 'must not be duplicated' }) },
      { verb: 'PUT', call: () => client.updateBook(5, { name: 'must not be replayed' }) },
      { verb: 'DELETE', call: () => client.deleteBook(5) },
    ];

    for (const { verb, call } of writes) {
      for (const status of RETRYABLE_STATUSES.filter((code) => code !== 429)) {
        it(`does NOT retry ${verb} after ${status}`, async () => {
          // A 5xx on a write may have partially applied upstream, so replaying it could
          // duplicate the work. The fallback would answer 200 - so if a retry happened,
          // the call resolves and the rejection assertion fails first.
          stub.plan = [{ status, body: { error: { message: 'upstream is unwell' } } }];
          stub.fallback = { status: 200, body: { id: 5 } };

          await expect(call()).rejects.toThrow(/error|unavailable|gateway|timeout/i);

          expect(stub.requests).toHaveLength(1);
          expect(stub.requests[0]?.method).toBe(verb);
          expect(waits).toEqual([]);
        });
      }
    }
  });

  describe('server-directed waits', () => {
    it('honours Retry-After in delta-seconds form', async () => {
      stub.plan = [
        { status: 429, headers: { 'Retry-After': '3' }, body: { error: { message: 'slow' } } },
        { status: 200, body: { data: [], total: 0 } },
      ];

      await client.listBooks();

      // Exactly what the server asked for, plus the settling margin - not backoff,
      // whose first step would be 500-625ms.
      expect(waits).toEqual([3000 + SETTLING_MARGIN_MS]);
    });

    it('honours Retry-After in HTTP-date form', async () => {
      stub.plan = [
        { status: 429, headers: { 'Retry-After': httpDate(8) }, body: { error: { message: 'x' } } },
        { status: 200, body: { data: [], total: 0 } },
      ];

      await client.listBooks();

      expect(waits).toHaveLength(1);
      // The date is converted to a delay from now, so allow for the clock moving
      // between the header being written and the response being parsed.
      expect(waits[0]).toBeGreaterThan(7000);
      expect(waits[0]).toBeLessThanOrEqual(8000 + SETTLING_MARGIN_MS);
    });

    it('falls back to X-RateLimit-Reset (delta-seconds) when Retry-After is absent', async () => {
      stub.plan = [
        { status: 429, headers: { 'X-RateLimit-Reset': '4' }, body: { error: { message: 'x' } } },
        { status: 200, body: { data: [], total: 0 } },
      ];

      await client.listBooks();

      expect(waits).toEqual([4000 + SETTLING_MARGIN_MS]);
    });

    it('falls back to X-RateLimit-Reset (Laravel unix timestamp) when Retry-After is absent', async () => {
      // What Laravel's throttle middleware actually emits: the epoch second the window
      // reopens, which has to be turned back into a delay.
      const resetAt = Math.floor(Date.now() / 1000) + 6;
      stub.plan = [
        {
          status: 429,
          headers: { 'X-RateLimit-Reset': String(resetAt) },
          body: { error: { message: 'x' } },
        },
        { status: 200, body: { data: [], total: 0 } },
      ];

      await client.listBooks();

      expect(waits).toHaveLength(1);
      // Between 5s and 6s away, depending on the sub-second remainder discarded above.
      expect(waits[0]).toBeGreaterThan(5000);
      expect(waits[0]).toBeLessThanOrEqual(6000 + SETTLING_MARGIN_MS);
    });

    it('prefers Retry-After over X-RateLimit-Reset when both are sent', async () => {
      // BookStack sends both on a 429; Retry-After is the standardised one.
      stub.plan = [
        {
          status: 429,
          headers: { 'Retry-After': '2', 'X-RateLimit-Reset': '9' },
          body: { error: { message: 'x' } },
        },
        { status: 200, body: { data: [], total: 0 } },
      ];

      await client.listBooks();

      expect(waits).toEqual([2000 + SETTLING_MARGIN_MS]);
    });

    it('ignores retry headers on a non-retryable status', async () => {
      // A wait is pointless when the condition is not transient: a 404 with a
      // Retry-After must still be a single attempt.
      stub.plan = [
        { status: 404, headers: { 'Retry-After': '5' }, body: { error: { message: 'gone' } } },
      ];
      stub.fallback = { status: 200, body: { id: 1 } };

      await expect(client.getBook(1)).rejects.toThrow(/not found/i);

      expect(stub.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  });

  describe('malformed or absurd header values fall back sanely', () => {
    const unusable: { label: string; headers: Record<string, string> }[] = [
      { label: 'a non-numeric Retry-After', headers: { 'Retry-After': 'soon' } },
      { label: 'a Retry-After that is only a sign', headers: { 'Retry-After': '+' } },
      {
        label: 'junk in both headers',
        headers: { 'Retry-After': 'whenever', 'X-RateLimit-Reset': 'later' },
      },
      { label: 'a non-integer X-RateLimit-Reset', headers: { 'X-RateLimit-Reset': '3.7' } },
      { label: 'a negative X-RateLimit-Reset', headers: { 'X-RateLimit-Reset': '-30' } },
    ];

    for (const { label, headers } of unusable) {
      it(`falls back to exponential backoff given ${label}`, async () => {
        stub.plan = [{ status: 429, headers, body: { error: { message: 'x' } } }];
        stub.fallback = { status: 200, body: { data: [], total: 0 } };

        await client.listBooks();

        expect(stub.requests).toHaveLength(2);
        // Self-computed first step: BASE_DELAY_MS, jittered upward by at most 25%.
        // Emphatically NOT a value derived from the junk above, and never 0.
        expect(waits).toHaveLength(1);
        expect(waits[0]).toBeGreaterThanOrEqual(BASE_DELAY_MS);
        expect(waits[0]).toBeLessThanOrEqual(Math.round(BASE_DELAY_MS * (1 + JITTER_RATIO)));
      });
    }

    it('never waits forever on an absurd Retry-After', async () => {
      // ~3 years. ErrorHandler clamps it to MAX_SERVER_DIRECTED_WAIT_MS (10 minutes),
      // which the total-wait budget then refuses outright: the error surfaces at once
      // rather than parking the process.
      stub.plan = [
        { status: 429, headers: { 'Retry-After': '99999999' }, body: { error: { message: 'x' } } },
      ];
      stub.fallback = { status: 200, body: { data: [], total: 0 } };

      await expect(client.listBooks()).rejects.toThrow(/rate limit exceeded/i);

      expect(stub.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('clamps a server-directed wait it can still afford to the believable maximum', async () => {
      // 20 minutes asked for, 10 minutes believed. Still over the 30s budget, so no
      // wait is taken - what is proven here is that the clamp happened at all, since an
      // unclamped 20 minutes would be indistinguishable from a clamped one by the
      // attempt count alone.
      const requestedSeconds = 1200;
      stub.fallback = {
        status: 429,
        headers: { 'Retry-After': String(requestedSeconds) },
        body: { error: { message: 'x' } },
      };

      const error = await client.listBooks().then(
        (value: unknown) => {
          throw new Error(`Expected a rejection, got ${JSON.stringify(value)}`);
        },
        (caught: unknown) => caught
      );

      expect(String(error)).toMatch(/rate limit exceeded/i);
      expect(stub.requests).toHaveLength(1);
      expect(waits).toEqual([]);

      // Prove the clamp through the only observable it has: the hint carried on the
      // error the loop gave up with.
      expect(new ErrorHandler(noopLogger).getRetryInfo(error).retryAfterMs).toBe(
        MAX_SERVER_DIRECTED_WAIT_MS
      );
      expect(MAX_SERVER_DIRECTED_WAIT_MS).toBeLessThan(requestedSeconds * 1000);
    });
  });

  /**
   * A header value HTTP itself cannot deliver.
   *
   * A blank `Retry-After` never reaches the client - Bun's HTTP stack drops a
   * whitespace-only header value outright (verified: axios sees no `retry-after` key at
   * all), so a stub cannot express one. Driving it through the server would therefore
   * test "no header" while claiming to test "blank header": a test that cannot fail for
   * the reason it states. The parser is the level at which the guard is reachable, so
   * that is where it is asserted.
   */
  describe('header values the transport cannot carry', () => {
    /** The error shape `getRetryInfo` accepts: an AxiosError before interception. */
    function axiosLike(status: number, headers: Record<string, string>): unknown {
      return { isAxiosError: true, response: { status, headers }, config: { method: 'get' } };
    }

    it('discards a blank Retry-After rather than reading it as a zero wait', () => {
      const handler = new ErrorHandler(noopLogger);

      const info = handler.getRetryInfo(axiosLike(429, { 'retry-after': '   ' }));

      expect(info.status).toBe(429);
      // Not 0: "the server said nothing" must stay distinguishable from "the server
      // said zero", or self-computed backoff is skipped in favour of no wait at all.
      expect(info.retryAfterMs).toBeUndefined();
    });

    it('discards a blank X-RateLimit-Reset rather than reading it as a zero wait', () => {
      const handler = new ErrorHandler(noopLogger);

      const info = handler.getRetryInfo(axiosLike(429, { 'x-ratelimit-reset': '  ' }));

      expect(info.retryAfterMs).toBeUndefined();
    });
  });

  describe('bounds', () => {
    it('gives up after 4 attempts and surfaces the last error', async () => {
      stub.fallback = {
        status: 429,
        headers: { 'Retry-After': '0' },
        body: { error: { message: 'always throttled' } },
      };

      await expect(client.listBooks()).rejects.toThrow(/rate limit exceeded/i);

      expect(stub.requests).toHaveLength(MAX_ATTEMPTS);
      // 4 attempts means exactly 3 waits, each the settling margin over `Retry-After: 0`.
      expect(waits).toEqual([SETTLING_MARGIN_MS, SETTLING_MARGIN_MS, SETTLING_MARGIN_MS]);
    });

    it('backs off exponentially with bounded jitter when the server gives no hint', async () => {
      stub.fallback = { status: 503, body: { error: { message: 'unavailable' } } };

      await expect(client.listBooks()).rejects.toThrow(/service unavailable/i);

      expect(stub.requests).toHaveLength(MAX_ATTEMPTS);
      expect(waits).toHaveLength(MAX_ATTEMPTS - 1);

      waits.forEach((wait, index) => {
        const step = BASE_DELAY_MS * 2 ** index;
        expect(wait).toBeGreaterThanOrEqual(step);
        expect(wait).toBeLessThanOrEqual(Math.round(step * (1 + JITTER_RATIO)));
      });

      // Doubling, not a flat delay: the third wait is at least 3x the first even at
      // the worst jitter draw (2000 vs 625).
      expect(waits[2]).toBeGreaterThan((waits[0] ?? 0) * 3);
      expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS);
    });

    it('refuses a single wait that would breach the total-wait budget', async () => {
      // 40s > the 30s budget: not worth waiting for, and not waited for.
      stub.fallback = {
        status: 429,
        headers: { 'Retry-After': '40' },
        body: { error: { message: 'come back tomorrow' } },
      };

      await expect(client.listBooks()).rejects.toThrow(/rate limit exceeded/i);

      expect(stub.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    });

    it('stops once the accumulated waits would breach the budget, short of the attempt cap', async () => {
      // 12s + margin per retry. Two fit inside the 30s budget (24.5s); the third would
      // reach 36.75s, so the loop stops at 3 attempts - one short of the 4 it is
      // otherwise allowed. This is the arm that only the running total can produce.
      stub.fallback = {
        status: 429,
        headers: { 'Retry-After': '12' },
        body: { error: { message: 'still throttled' } },
      };

      await expect(client.listBooks()).rejects.toThrow(/rate limit exceeded/i);

      const perWait = 12_000 + SETTLING_MARGIN_MS;
      expect(waits).toEqual([perWait, perWait]);
      expect(stub.requests).toHaveLength(3);
      expect(stub.requests.length).toBeLessThan(MAX_ATTEMPTS);
      expect(waits.reduce((sum, wait) => sum + wait, 0) + perWait).toBeGreaterThan(
        MAX_TOTAL_WAIT_MS
      );
    });

    const nonRetryable = [400, 401, 403, 404, 422] as const;
    for (const status of nonRetryable) {
      it(`makes exactly one attempt on ${status}`, async () => {
        stub.plan = [{ status, body: { error: { message: 'not transient' } } }];
        stub.fallback = { status: 200, body: { data: [], total: 0 } };

        await expect(client.listBooks()).rejects.toThrow();

        expect(stub.requests).toHaveLength(1);
        expect(waits).toEqual([]);
      });
    }
  });

  describe('multipart replay', () => {
    it('re-serialises the body of a retried multipart POST', async () => {
      // The regression this guards: the form is built once and the config is only
      // shallow-copied per attempt, so a body that survived as a consumed stream would
      // reach the server empty the second time - an upload that silently uploads
      // nothing, answered with a perfectly ordinary 200.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

      stub.plan = [
        { status: 429, headers: { 'Retry-After': '0' }, body: { error: { message: 'slow down' } } },
        { status: 200, body: { id: 99, name: 'w6-retry.png' } },
      ];

      const result = await client.createImage({
        name: 'w6-retry.png',
        type: 'gallery',
        uploaded_to: 4,
        image: png.toString('base64'),
      });

      expect(stub.requests).toHaveLength(2);
      const [first, second] = stub.requests;
      if (!first || !second) throw new Error('expected two attempts');

      expect(second.method).toBe('POST');

      // The replayed body carries the file part and the real image bytes, decoded from
      // base64 - not an empty stream, and not a truncated one. Asserted before the
      // headers, because an empty replay is the failure worth naming: an upload that
      // silently uploads nothing.
      const replayed = second.body.toString('latin1');
      expect(second.body.byteLength).toBeGreaterThan(png.byteLength);
      expect(replayed).toContain('name="image"; filename="w6-retry.png"');
      expect(replayed).toContain(png.toString('latin1'));
      expect(replayed).toContain('name="uploaded_to"');

      expect(second.contentType).toMatch(/^multipart\/form-data; boundary=/);

      // Byte-for-byte identical to the first attempt once the per-attempt random
      // boundary is normalised away.
      expect(multipartWithoutBoundary(second)).toBe(multipartWithoutBoundary(first));
      expect(result.id).toBe(99);
      expect(result.name).toBe('w6-retry.png');
    });
  });
});
