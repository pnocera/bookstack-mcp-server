/**
 * Redaction, asserted where it actually matters: the bytes the process writes out.
 *
 * WHY THIS FILE EXISTS. Round 3 reported this proof as done, having run it by hand and
 * never committed it. Round 4 then probed the shipped redactor and got three markers
 * straight through - a credential in URL userinfo, a caller's `file_path` inside error
 * text, and the message of a plain `Error`, which the redactor deliberately exempted. An
 * uncommitted proof is not a proof; it is a claim. So every rule below is pinned to an
 * observed byte stream, and each one fails if its rule is reverted.
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY.
 *
 * Markers are unique nonsense strings. `expect(output).not.toContain(marker)` cannot pass
 * by accident: there is no other route by which the string could reach the output, and no
 * partial-credit reading of the result.
 *
 * The capture wraps `process.stdout.write`/`process.stderr.write`, so what is examined is
 * what Winston actually rendered through the real Console transport at the real level -
 * not what `redactLogMeta()` returns. A redactor that works and a formatter that prints
 * the raw object anyway would pass a function-level test and fail this one.
 *
 * THE OPPOSITE FAILURE IS ASSERTED TOO. A redactor that blanked every field would satisfy
 * every `not.toContain` here, and would be useless: an operator could no longer tell a 404
 * from a timeout. `keeps the stable identity of an error` and the `context` assertions
 * below are what stop "leaks nothing" from being reached by "says nothing".
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  Logger,
  type LoggingOptions,
  redactLogMeta,
  registerSafeNames,
} from '../../src/utils/logger';

/**
 * The names a real server registers, in miniature.
 *
 * `tool`, `resource`, `argument_names`, `fields`, `filters` and `param_names` are rendered
 * only for names this process declared as its own - see VOCABULARY_KEY_PATTERN. src/server.ts
 * declares them from its live tool and resource registries; this file has no server, so it
 * declares the handful its cases use. Registering is additive and process-wide, so nothing
 * here is ever un-registered: every "withheld" assertion below uses a unique marker that no
 * registry could contain.
 */
registerSafeNames([
  'bookstack_books_update',
  'bookstack://books/{id}',
  'id',
  'name',
  'description',
  'book_id',
  'count',
  'filter',
]);

/**
 * Unique, unmistakable, and structurally varied - each marker rides in on a different
 * kind of value, because the rules that carry them are different rules.
 */
const MARKERS = {
  password: 'PW-marker-9f3a1c7e',
  html: 'HTML-marker-4b8d2e6a',
  markdown: 'MD-marker-1c5f9a3b',
  base64: 'B64-marker-7e2d4f8c',
  filePath: 'PATH-marker-3a9c1e5d',
  urlUserinfo: 'URLUSER-marker-6d4b8f2a',
  urlQuery: 'URLQS-marker-2f7a9c3e',
  upstreamData: 'UPSTREAM-marker-8b1e5d7f',
  errorMessage: 'ERRMSG-marker-5c3f7b9d',
  // R5-W3's vectors. None of these keys looks like a credential, a payload or error prose,
  // which is exactly why the blocklist let all four through at the DEFAULT level.
  searchQuery: 'QUERY-marker-7a2e9d41',
  userName: 'NAME-marker-3f8b6c25',
  userEmail: 'EMAIL-marker-9d1a4e73',
  filterValue: 'FILTER-marker-2c6f8a19',
  // A credential whose spelling the old URL matcher truncated before parsing. Both of these
  // characters are legal in userinfo and Bun's URL parser keeps them.
  urlParenUserinfo: 'URLPAREN-marker-5e3d7b28',
  urlQuoteUserinfo: 'URLQUOTE-marker-1b9f4c63',
  urlBraceQuery: 'URLBRACE-marker-8c2a5e17',
  // A URL this module cannot parse at all (a backslash in userinfo), carrying a credential.
  urlUnparsable: 'URLBAD-marker-4d7e1a95',
} as const;

const ALL_MARKERS: readonly string[] = Object.values(MARKERS);

const logger = Logger.getInstance();
const originalOptions: LoggingOptions = logger.getOptions();

afterAll(() => {
  // The Logger is a process-wide singleton and bun runs this file alongside others.
  logger.configure(originalOptions);
});

type WriteFn = typeof process.stdout.write;

interface Captured {
  stdout: string;
  stderr: string;
  /** Both streams together: no rule here is allowed to leak into either one. */
  combined: string;
}

/**
 * Run `emit` with both standard streams intercepted, and return everything written.
 *
 * The `setImmediate` is load-bearing rather than superstition: a Winston logger is a
 * stream, so a line logged now can be written on a later tick. Restoring the real writers
 * before that happened would let the line escape the capture and read as "nothing was
 * written", which is exactly the false green this file exists to prevent.
 */
async function capture(emit: () => void): Promise<Captured> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  const collect = (chunks: string[]): WriteFn =>
    ((chunk: unknown): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as WriteFn;

  process.stdout.write = collect(stdoutChunks);
  process.stderr.write = collect(stderrChunks);
  try {
    emit();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
  }

  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');
  return { stdout, stderr, combined: `${stdout}${stderr}` };
}

/** Every marker, through every rule, in one line's worth of meta. */
function everyLeakVector(): Record<string, unknown> {
  return {
    password: MARKERS.password,
    html: `<p>${MARKERS.html}</p>`,
    markdown: `# ${MARKERS.markdown}`,
    file: `data:image/png;base64,${MARKERS.base64}`,
    file_path: `/srv/uploads/${MARKERS.filePath}.png`,
    // `url` rather than `baseUrl`: since R6-W3 no key vouches for a base URL - the redactor
    // keeps a URL's PATH, and a base URL's path is the operator's arbitrary text - so this
    // vector would have been removed by the KEY rule and proved nothing about the URL rules.
    // `url` is the key the API client really logs its request paths under, and it is
    // rendered, so what has to strip the credential here is the URL rule itself.
    url: `https://alice:${MARKERS.urlUserinfo}@bookstack.example.com/api?api_token=${MARKERS.urlQuery}&count=5`,
    // The two shapes src/server.ts and src/api/client.ts actually log at their catch
    // sites - strings, under keys that no credential rule would ever match.
    error: `ENOENT: no such file '/srv/uploads/${MARKERS.filePath}.png'`,
    stack: `Error: upload of '/srv/uploads/${MARKERS.filePath}.png' failed\n    at assertUploadPathAllowed (/app/src/api/client.ts:330:11)`,
    data: { error: { message: MARKERS.upstreamData, code: 422 } },
    // The case redactValue() used to exempt outright.
    cause: new Error(MARKERS.errorMessage),
    // R5-W3, in the shapes the call sites used to write them: the caller's whole search
    // string, a person's name and email address, and a list filter's value. All four are
    // ordinary strings under ordinary keys, which is the entire point - the allowlist has
    // to withhold them because nothing about them looks dangerous.
    query: `case ${MARKERS.searchQuery} {type:page}`,
    name: MARKERS.userName,
    email: `${MARKERS.userEmail}@example.com`,
    params: { count: 20, filter: { name: MARKERS.filterValue } },
    // The URL spellings the matcher used to truncate. Every one of these rides under a
    // `url` key on purpose, so these strings ARE rendered: what has to remove the credential
    // is the URL rule itself, with no help from the key. Under an unvouched-for key they
    // would be sized, and the assertion would pass without the URL rule doing anything.
    //
    // Nested, which also pins that a URL key inside an object is judged on its own name -
    // `request`, `retry` and `fallback` vouch for nothing, and do not need to.
    request: {
      url: `https://alice:${MARKERS.urlParenUserinfo})x@example.com/api?api_token={${MARKERS.urlBraceQuery}}`,
    },
    retry: { url: `https://alice:${MARKERS.urlQuoteUserinfo}'x@example.com/api` },
    fallback: { url: `https://alice:${MARKERS.urlUnparsable}\\x@example.com/api` },
  };
}

/**
 * `info` is the default and `debug` is what an operator turns on when something is wrong -
 * which is exactly when a leak would be written. The claim is "no level", so both are run.
 */
const LEVELS = ['info', 'debug'] as const;

describe('no marker survives to the output stream', () => {
  for (const level of LEVELS) {
    for (const format of ['json', 'pretty'] as const) {
      it(`at level=${level} format=${format}`, async () => {
        logger.configure({ level, format });

        const { stdout, stderr, combined } = await capture(() => {
          logger[level]('Tool bookstack_attachments_create failed', everyLeakVector());
        });

        // The line was really written - otherwise every assertion below is vacuous.
        expect(stderr.length).toBeGreaterThan(0);
        expect(stderr).toContain('bookstack_attachments_create');

        for (const marker of ALL_MARKERS) {
          expect(combined, `${marker} must not reach the output`).not.toContain(marker);
        }

        // stdout carries the MCP JSON-RPC stream under the stdio transport; a log line
        // there corrupts the protocol regardless of whether it was redacted.
        expect(stdout).toBe('');
      });
    }
  }

  it('keeps no marker even when the Error is the whole meta argument', async () => {
    // src/api/client.ts:477 does exactly this - `logger.error('...', error)`.
    logger.configure({ level: 'debug', format: 'json' });
    const error = Object.assign(new Error(`Request failed: ${MARKERS.upstreamData}`), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 422 },
    });

    const { combined } = await capture(() => {
      logger.error('Request interceptor error', error);
    });

    expect(combined).not.toContain(MARKERS.upstreamData);
  });
});

/**
 * The other half of the contract. Every assertion above is satisfied by a redactor that
 * writes nothing at all, so these say what must SURVIVE. Without them, "trade a leak for a
 * blind spot" passes CI.
 */
describe('stable diagnostic context survives redaction', () => {
  it('keeps the identity, code and status of an upstream error', async () => {
    logger.configure({ level: 'info', format: 'json' });
    const error = Object.assign(new Error(`422 from upstream: ${MARKERS.upstreamData}`), {
      name: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      response: { status: 422 },
    });

    const { stderr } = await capture(() => {
      logger.error('API error', { err: error });
    });

    // The line still says what kind of failure this was, from where, and with which
    // upstream status - the three things an operator needs and none of them prose.
    expect(stderr).toContain('AxiosError');
    expect(stderr).toContain('ERR_BAD_REQUEST');
    expect(stderr).toContain('422');
    expect(stderr).toContain('API error');
    // ...and the message itself is accounted for rather than silently vanished.
    expect(stderr).toContain('redacted');
    expect(stderr).not.toContain(MARKERS.upstreamData);
  });

  it('keeps the frames of a stack while dropping its message line', async () => {
    logger.configure({ level: 'info', format: 'json' });
    const error = new Error(MARKERS.errorMessage);
    error.stack = `Error: ${MARKERS.errorMessage}\n    at assertUploadPathAllowed (/app/src/api/client.ts:330:11)\n    at handler (/app/src/tools/attachments.ts:120:5)`;

    const { stderr } = await capture(() => {
      logger.error('Tool failed', { err: error });
    });

    // "Where did it throw" is the single most useful fact about a failure, and it is a
    // code location rather than caller text - so it stays.
    expect(stderr).toContain('assertUploadPathAllowed');
    expect(stderr).toContain('client.ts:330');
    expect(stderr).toContain('attachments.ts:120');
    expect(stderr).not.toContain(MARKERS.errorMessage);
  });

  it('refuses a frame-shaped line that carries prose instead of a source location', async () => {
    // Found by re-running R4-W3's own probe against this fix. `stack` is just a string
    // key, and the first version of safeStack() kept any line starting with 'at ' - so
    // `at upload (/srv/uploads/<caller's path>)`, which is prose wearing a frame's
    // clothes, was printed verbatim while the message beside it was redacted. A real V8
    // frame always ends in :line:col, so requiring one keeps the genuine frames and
    // refuses the impostor.
    logger.configure({ level: 'info', format: 'json' });

    const { stderr } = await capture(() => {
      logger.error('Tool failed', {
        error: `ENOENT: '/srv/uploads/${MARKERS.filePath}.png'`,
        stack:
          `Error: upload failed\n` +
          `    at upload (/srv/uploads/${MARKERS.filePath}.png)\n` +
          `    at readGuardedUploadFile (/app/src/api/client.ts:318:30)`,
      });
    });

    expect(stderr).not.toContain(MARKERS.filePath);
    // The genuine frame beside it still survives.
    expect(stderr).toContain('readGuardedUploadFile');
    expect(stderr).toContain('client.ts:318:30');
  });

  it('keeps the host, path and non-sensitive query of a sanitized URL', async () => {
    logger.configure({ level: 'info', format: 'json' });

    const { stderr } = await capture(() => {
      // The API client's request line, whose `url` this codebase built out of its own route
      // constants. This used to be the client's `baseUrl` line, which no longer renders a
      // URL at all - see the base-URL section below for why, and for what it logs instead.
      logger.info('API request', {
        url: `https://alice:${MARKERS.urlUserinfo}@bookstack.example.com:8443/api?api_token=${MARKERS.urlQuery}&count=5`,
        timeout: 30000,
      });
    });

    // A URL that has been emptied of everything is no more useful than no URL at all.
    expect(stderr).toContain('bookstack.example.com:8443');
    expect(stderr).toContain('/api');
    expect(stderr).toContain('count=5');
    expect(stderr).toContain('30000');
    expect(stderr).not.toContain(MARKERS.urlUserinfo);
    expect(stderr).not.toContain(MARKERS.urlQuery);
  });

  it('keeps the sibling facts on the line src/api/client.ts logs at its error catch', async () => {
    logger.configure({ level: 'info', format: 'json' });

    const { stderr } = await capture(() => {
      // The exact shape of client.ts:493.
      logger.error('API error', {
        status: 422,
        url: '/pages',
        method: 'POST',
        message: `The name field is required. ${MARKERS.upstreamData}`,
        data: { error: { message: MARKERS.upstreamData, code: 422 } },
      });
    });

    expect(stderr).toContain('422');
    expect(stderr).toContain('/pages');
    expect(stderr).toContain('POST');
    expect(stderr).not.toContain(MARKERS.upstreamData);
  });
});

/**
 * The structural URL rules, stated one at a time.
 *
 * These go through `redactLogMeta` rather than the output stream: the output-level proof
 * is above, and what these pin down is the SHAPE of the rewrite, which is easier to read
 * as a value than as a substring of a rendered line.
 *
 * WHY THE KEY IS `url`. Since R5-W3 a string is only rendered when its key vouches for it,
 * and `url` is the key the API client actually logs its request paths under. Sending these
 * through an arbitrary key would prove nothing about the URL rules: the allowlist would
 * reduce every one of them to a size before the URL code ran. That the allowlist does
 * exactly that is asserted in its own section below.
 */
describe('URLs are sanitized structurally rather than by key name', () => {
  function sanitizedUrl(value: string): string {
    const result = redactLogMeta({ url: value });
    return (result as Record<string, string>).url;
  }

  it('drops userinfo but records that the URL carried some', () => {
    expect(sanitizedUrl('https://alice:hunter2@example.com/api')).toBe(
      'https://[redacted]@example.com/api'
    );
  });

  it('redacts sensitive query values and keeps the rest', () => {
    expect(sanitizedUrl('https://example.com/api?api_token=abc&count=5&secret=x&sort=name')).toBe(
      'https://example.com/api?api_token=REDACTED&count=5&secret=REDACTED&sort=name'
    );
  });

  it('applies to a URL embedded in prose, under a key with no special meaning', () => {
    // The R4-W3 case: `baseUrl` is not a credential key, and this text is not a URL - it
    // merely contains one.
    const result = sanitizedUrl('connect failed for https://bob:pw-secret@host/api, retrying');
    expect(result).toContain('https://[redacted]@host/api');
    expect(result).not.toContain('pw-secret');
  });

  it('re-encodes a query value that would otherwise forge a log line', () => {
    // A newline surviving into a rendered line lets a caller write their own log entries.
    const result = sanitizedUrl('https://example.com/api?q=a%0A2026-01-01%20%5Berror%5D%20forged');
    expect(result).not.toContain('\n');
  });

  it('leaves a string that only looks like a URL alone', () => {
    expect(sanitizedUrl('not a url, just prose about https and ://')).toBe(
      'not a url, just prose about https and ://'
    );
  });

  it('strips userinfo from an IPv6 authority', () => {
    // Found by probing this fix rather than the old code: the URL matcher first excluded
    // square brackets, so the match stopped at '[', `new URL()` rejected the truncated
    // 'http://alice:pw@' fragment, and the WHOLE string - credential included - was
    // returned unredacted. An IPv6 BookStack host is the one place userinfo could still
    // have ridden into a log.
    expect(sanitizedUrl('http://alice:ipv6-secret@[::1]:8080/api')).toBe(
      'http://[redacted]@[::1]:8080/api'
    );
  });

  it('keeps an IPv6 host intact when there is nothing to redact', () => {
    expect(sanitizedUrl('http://[::1]:8080/api?count=5')).toBe('http://[::1]:8080/api?count=5');
  });

  it('gives back a bracket that belonged to the prose, not to an address', () => {
    expect(sanitizedUrl('see [https://example.com/api] for details')).toBe(
      'see [https://example.com/api] for details'
    );
  });

  it('gives back trailing sentence punctuation', () => {
    expect(sanitizedUrl('connect to https://example.com/api.')).toBe(
      'connect to https://example.com/api.'
    );
  });

  /**
   * R5-W3's second half, one legal spelling at a time.
   *
   * The matcher used to stop at the characters that usually DELIMIT a URL in prose. Every
   * one of them is legal inside userinfo or a query, and Bun's URL parser keeps them - so
   * the match was truncated to `https://alice:pw`, which is not a URL (`pw` is not a port),
   * the parse failed, and the fallback returned the ORIGINAL string with the credential in
   * it. Each case below leaves the password unredacted on the old matcher.
   */
  describe('a credential spelled with a URL delimiter', () => {
    const SPELLINGS: readonly { label: string; password: string }[] = [
      { label: 'closing paren', password: 'pw)marker' },
      { label: 'opening paren', password: 'pw(marker' },
      { label: 'apostrophe', password: "pw'marker" },
      { label: 'double quote', password: 'pw"marker' },
      { label: 'backtick', password: 'pw`marker' },
      { label: 'braces', password: 'pw{marker}' },
      { label: 'angle brackets', password: 'pw<marker>' },
      { label: 'all of them at once', password: 'pw)(\'"`{}<>marker' },
    ];

    for (const { label, password } of SPELLINGS) {
      it(`is dropped when the password contains a ${label}`, () => {
        const result = sanitizedUrl(`https://alice:${password}@example.com/api`);

        expect(result).toBe('https://[redacted]@example.com/api');
        // Belt and braces: the marker cannot survive under any encoding of itself either,
        // since the whole userinfo is gone rather than rewritten.
        expect(result).not.toContain('marker');
      });
    }

    it('is dropped from a query value spelled with braces', () => {
      // The same truncation, one component along: the match stopped at `{`, so
      // `?api_token=` parsed cleanly and was "redacted" while `{secret}` stayed behind as
      // prose the caller could read.
      expect(sanitizedUrl('https://example.com/api?api_token={s3cret}&count=5')).toBe(
        'https://example.com/api?api_token=REDACTED&count=5'
      );
    });
  });

  /**
   * The conservative branch, which is the reason the delimiter fix cannot be reintroduced
   * quietly. When neither the run as it stands nor the run minus its trailing punctuation
   * parses, this module does not understand the value - and a value it does not understand
   * is exactly where a credential hides.
   */
  describe('a URL-shaped run that cannot be parsed is withheld whole', () => {
    it('withholds a userinfo spelled with a backslash', () => {
      // Bun rejects this one outright: the backslash is a path separator to the WHATWG
      // parser, so there is nothing to take apart and the password would otherwise ride
      // through as prose.
      const result = sanitizedUrl('https://alice:pw\\marker@example.com/api');

      expect(result).toBe('[redacted: unparsable URL]');
      expect(result).not.toContain('marker');
    });

    it('withholds a URL whose port is not a number', () => {
      const result = sanitizedUrl('https://alice:pw-marker@example.com:99999999/api');

      expect(result).toBe('[redacted: unparsable URL]');
      expect(result).not.toContain('marker');
    });

    it('withholds only the run, leaving the prose around it', () => {
      expect(sanitizedUrl('connect failed for https://alice:pw@host:99999999/api, retrying')).toBe(
        'connect failed for [redacted: unparsable URL] retrying'
      );
    });
  });
});

/**
 * THE ALLOWLIST ITSELF: a string is withheld unless its key proves it safe.
 *
 * R5-W3's first half. The redactor named the payload keys it knew about and let every other
 * string through, so the values that actually walked out were the ones nobody had thought
 * to name: a search query, a person's name and email, a list filter. This section asserts
 * the rule rather than the list - the default for an unknown key is what decides whether
 * the NEXT call site leaks, and the default is the only part of this a future field
 * inherits for free.
 */
describe('a string is withheld unless its key vouches for it', () => {
  function redactedRecord(meta: Record<string, unknown>): Record<string, unknown> {
    return redactLogMeta(meta) as Record<string, unknown>;
  }

  it('reports the size of a value under a key nobody vouched for', () => {
    // The four R5-W3 named, plus a key that does not exist yet - which is the case this
    // rule is really for.
    expect(
      redactedRecord({
        query: 'confidential case name',
        name: 'Alice Example',
        email: 'alice@example.com',
        display_name: 'Alice',
        filename: 'Q3 Board Minutes.pdf',
        some_field_invented_next_year: 'whatever it holds',
      })
    ).toEqual({
      query: '[redacted: 22 chars]',
      name: '[redacted: 13 chars]',
      email: '[redacted: 17 chars]',
      display_name: '[redacted: 5 chars]',
      filename: '[redacted: 20 chars]',
      some_field_invented_next_year: '[redacted: 17 chars]',
    });
  });

  it('withholds a filter value nested inside a query object', () => {
    // The axios request line's old shape. Recursion does not launder a value: every level
    // is judged on its own key, and `name` does not vouch for anything.
    expect(redactedRecord({ params: { count: 20, filter: { name: 'ACME Corp' } } })).toEqual({
      params: { count: 20, filter: { name: '[redacted: 9 chars]' } },
    });
  });

  it('withholds a string handed in as the whole meta argument', () => {
    // No key at all, so nothing has vouched for it.
    expect(redactLogMeta('a bare string with a name in it')).toBe('[redacted: 31 chars]');
  });

  it('withholds a URL under a key that does not vouch for it, rather than rendering it', () => {
    // The allowlist runs BEFORE the URL rules, so an unvouched-for URL never even reaches
    // them. Host and path are diagnostic when the client logs its own request; they are the
    // caller's text when they arrive under some other name.
    expect(redactedRecord({ callback: 'https://example.com/hook?ref=SECRET' })).toEqual({
      callback: '[redacted: 35 chars]',
    });
  });

  /**
   * The other half, or "withhold everything" would pass the whole section above.
   *
   * Each of these is a real log line's meta, and each key on it earns its place in
   * SAFE_STRING_KEY_PATTERN by being written by this codebase from a fixed vocabulary.
   */
  it('renders the keys that vouch for their value', () => {
    expect(
      redactedRecord({
        method: 'PUT',
        url: '/books/5',
        type: 'validation_error',
        content_type: 'book',
        format: 'pdf',
        encoding: 'base64',
        mimeType: 'application/pdf',
        source: 'file_path',
        sort: '-created_at',
        fileField: 'image',
        schema: 'booksUpdate',
        issue_codes: ['unrecognized_keys'],
        base_origin: 'https://books.example.com',
        base_path: '/api',
        base_path_digest: 'a1b2c3d4e5f6',
        status: 422,
        bytes: 51200,
      })
    ).toEqual({
      method: 'PUT',
      url: '/books/5',
      type: 'validation_error',
      content_type: 'book',
      format: 'pdf',
      encoding: 'base64',
      mimeType: 'application/pdf',
      source: 'file_path',
      sort: '-created_at',
      fileField: 'image',
      schema: 'booksUpdate',
      issue_codes: ['unrecognized_keys'],
      // An origin is URL-shaped, so it goes through the URL rules like any other rendered
      // string - which reassembles it from the parsed components and spells its empty path
      // as '/'. Cosmetic, and worth having: the rule is that a rendered string is sanitized,
      // not that some strings are exempt because of where they came from.
      base_origin: 'https://books.example.com/',
      base_path: '/api',
      base_path_digest: 'a1b2c3d4e5f6',
      status: 422,
      bytes: 51200,
    });
  });

  /**
   * R6-W3: `baseUrl` is not one of those keys any more, and this is the case that says why.
   *
   * The URL rules keep a path - `/books/5` is the diagnostic half of a request line - so an
   * allowlisted base URL is rendered path and all, and a base URL's path is the one part an
   * operator supplied. `https://books.example/<reverse-proxy capability>/api` therefore went
   * to the log at `info` on every single startup, with no failure and no attacker involved.
   * The previous round's check put its marker in the QUERY, watched it disappear, and
   * concluded the line was safe.
   */
  it('withholds a base URL, whose path is the operator’s and not this codebase’s', () => {
    const marker = 'PROXYPATH-marker-6b1d9e42';

    expect(redactedRecord({ baseUrl: `https://books.example/${marker}/api` })).toEqual({
      baseUrl: '[redacted: 51 chars]',
    });
    expect(redactedRecord({ base_url: `https://books.example/${marker}/api` })).toEqual({
      base_url: '[redacted: 51 chars]',
    });
  });

  /**
   * THE VOCABULARY RULE: a NAME is rendered only if this process registered it.
   *
   * R6-W2. These five keys were on the plain allowlist, justified as "key names come out of
   * our schemas". Two ways that was false: src/server.ts logged `tool` and `argument_names`
   * BEFORE looking the tool up, so both were unexamined caller strings; and with
   * VALIDATION_STRICT_MODE off, validateParams() returns the caller's object unchanged, so
   * `fields`/`filters`/`param_names` - all built by `Object.keys()` of it - are the caller's
   * text too. The claim was right about where these names usually come from and wrong about
   * where they can come from, so it is now checked against the registry at the top of this
   * file.
   */
  it('renders a name this server registered', () => {
    expect(
      redactedRecord({
        tool: 'bookstack_books_update',
        resource: 'bookstack://books/{id}',
        argument_names: ['id', 'name'],
        fields: ['name', 'description'],
        filters: ['book_id'],
        param_names: ['count', 'filter'],
      })
    ).toEqual({
      tool: 'bookstack_books_update',
      // The resource TEMPLATE, which is a constant of the codebase. Rendered verbatim: a
      // registered name is byte-identical to a string we wrote, so it is not put through
      // the URL rules, which would otherwise rewrite `{id}` into percent-encoding.
      resource: 'bookstack://books/{id}',
      argument_names: ['id', 'name'],
      fields: ['name', 'description'],
      filters: ['book_id'],
      param_names: ['count', 'filter'],
    });
  });

  it('withholds a name this server never registered, under those same keys', () => {
    // The exact shapes R6-W2's probe used: a marker as an unknown tool name, and a marker
    // as an unknown argument/filter/param KEY - which is what a caller sends in non-strict
    // mode, and what the old rule rendered verbatim at the default level.
    const marker = 'VOCAB-marker-2d7f4a91';

    expect(
      redactedRecord({
        tool: marker,
        resource: `bookstack://search/${marker}`,
        argument_names: ['id', marker],
        fields: [marker],
        filters: [marker],
        param_names: [marker],
      })
    ).toEqual({
      tool: '[redacted: 21 chars]',
      resource: '[redacted: 40 chars]',
      // The registered name beside it still renders: this withholds the caller's names, not
      // every name, or the line would say nothing at all.
      argument_names: ['id', '[redacted: 21 chars]'],
      fields: ['[redacted: 21 chars]'],
      filters: ['[redacted: 21 chars]'],
      param_names: ['[redacted: 21 chars]'],
    });
  });

  it('does not let a vouched-for key vouch for the object under it', () => {
    // `fields` renders the strings IN it - they are schema key names - but a nested object
    // is judged property by property on its own keys, so nothing inherits permission.
    expect(redactedRecord({ url: { name: 'Alice', secret: 'x', method: 'GET' } })).toEqual({
      url: { name: '[redacted: 5 chars]', secret: '[redacted]', method: 'GET' },
    });
  });
});

/**
 * Log forging through the one message that interpolates caller input.
 *
 * `src/server.ts` logs `Tool called: ${name}` at info BEFORE looking the name up, so the
 * name on that line is whatever arrived over the wire.
 */
describe('control characters cannot forge a log line', () => {
  it('escapes newlines in the message', async () => {
    logger.configure({ level: 'info', format: 'pretty' });

    const { stderr } = await capture(() => {
      logger.info('Tool called: evil\n2026-01-01 [error] FORGED LINE');
    });

    const lines = stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(stderr).toContain('\\x0a');
  });
});
