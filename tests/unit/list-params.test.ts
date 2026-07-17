/**
 * Coverage for the tool-input -> wire-format list mappers in src/types.ts:
 * `toPagesListParams` and `toRolesListParams`.
 *
 * ## What these mappers are for
 *
 * `draft`, `template` and `mfa_enforced` are `tinyint(1)` columns, and BookStack drops
 * a filter value straight into a SQL comparison without casting it. MySQL coerces the
 * string "true" to 0, so `filter[draft]=true` means `draft = 0` - it returns the
 * NON-drafts, as a clean HTTP 200 with nothing to indicate the answer is the exact
 * opposite of the question. Only 1/0 reads correctly.
 *
 * The mapping therefore lives in these functions rather than in a zod `.transform()`,
 * so that it runs unconditionally - a caller that bypasses validation still gets a
 * correct query.
 *
 * ## What is asserted
 *
 * Both branches of every flag, because they fail differently:
 *
 *  - `true` -> 1. A dropped mapper leaves the boolean `true`, which reads as 0.
 *  - `false` -> 0. The easy regression: `false` must survive as the number 0, not
 *    vanish (which drops the filter and returns everything) and not become "false".
 *  - absent -> absent. `undefined` must not collapse into 0, which would silently
 *    filter an unfiltered query down to non-drafts.
 *
 * The last describe closes the loop the mappers exist for by driving the real tools
 * against a local `Bun.serve` stub and reading the query string BookStack would have
 * received. A unit test of the mapper's return value alone cannot see a serializer
 * turning 0 back into "false"; this can. No Docker, no live instance.
 */

import { describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { PageTools } from '../../src/tools/pages';
import { RoleTools } from '../../src/tools/roles';
import {
  type PagesListInput,
  type RolesListInput,
  toPagesListParams,
  toRolesListParams,
} from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';

describe('toPagesListParams', () => {
  it('maps draft: true onto the number 1', () => {
    const params = toPagesListParams({ filter: { draft: true } });

    expect(params.filter?.draft).toBe(1);
    // Not the boolean `true`, which MySQL would read as 0 - i.e. as `draft: false`.
    expect(typeof params.filter?.draft).toBe('number');
  });

  it('maps draft: false onto the number 0, keeping the filter', () => {
    const params = toPagesListParams({ filter: { draft: false } });

    expect(params.filter?.draft).toBe(0);
    expect(typeof params.filter?.draft).toBe('number');
    // The filter must still be there: dropping it returns drafts *and* non-drafts.
    expect(Object.hasOwn(params.filter ?? {}, 'draft')).toBe(true);
  });

  it('maps template: true onto the number 1', () => {
    const params = toPagesListParams({ filter: { template: true } });

    expect(params.filter?.template).toBe(1);
    expect(typeof params.filter?.template).toBe('number');
  });

  it('maps template: false onto the number 0, keeping the filter', () => {
    const params = toPagesListParams({ filter: { template: false } });

    expect(params.filter?.template).toBe(0);
    expect(typeof params.filter?.template).toBe('number');
    expect(Object.hasOwn(params.filter ?? {}, 'template')).toBe(true);
  });

  it('maps both flags at once and passes every other field through untouched', () => {
    const params = toPagesListParams({
      count: 50,
      offset: 10,
      sort: '-updated_at',
      filter: {
        book_id: 3,
        chapter_id: 4,
        name: 'Exact Name',
        created_by: 7,
        draft: false,
        template: true,
      },
    });

    expect(params).toEqual({
      count: 50,
      offset: 10,
      sort: '-updated_at',
      filter: {
        book_id: 3,
        chapter_id: 4,
        name: 'Exact Name',
        created_by: 7,
        draft: 0,
        template: 1,
      },
    });
  });

  it('leaves an omitted flag omitted rather than defaulting it to 0', () => {
    const params = toPagesListParams({ filter: { book_id: 3 } });

    // `undefined` means "do not filter". Mapping it to 0 would quietly narrow the
    // result set to non-drafts.
    expect(Object.hasOwn(params.filter ?? {}, 'draft')).toBe(false);
    expect(Object.hasOwn(params.filter ?? {}, 'template')).toBe(false);
    expect(params.filter).toEqual({ book_id: 3 });
  });

  it('handles a query with no filter at all', () => {
    const params = toPagesListParams({ count: 20, offset: 0, sort: 'name' });

    expect(params).toEqual({ count: 20, offset: 0, sort: 'name' });
    expect(Object.hasOwn(params, 'filter')).toBe(false);
  });

  it('does not mutate its input', () => {
    const input: PagesListInput = { count: 5, filter: { draft: true, template: false } };

    toPagesListParams(input);

    expect(input).toEqual({ count: 5, filter: { draft: true, template: false } });
  });
});

describe('toRolesListParams', () => {
  it('maps mfa_enforced: true onto the number 1', () => {
    const params = toRolesListParams({ filter: { mfa_enforced: true } });

    expect(params.filter?.mfa_enforced).toBe(1);
    expect(typeof params.filter?.mfa_enforced).toBe('number');
  });

  it('maps mfa_enforced: false onto the number 0, keeping the filter', () => {
    const params = toRolesListParams({ filter: { mfa_enforced: false } });

    expect(params.filter?.mfa_enforced).toBe(0);
    expect(typeof params.filter?.mfa_enforced).toBe('number');
    expect(Object.hasOwn(params.filter ?? {}, 'mfa_enforced')).toBe(true);
  });

  it('passes every other field through untouched', () => {
    const params = toRolesListParams({
      count: 30,
      offset: 2,
      sort: '-display_name',
      filter: {
        display_name: 'Editor',
        description: 'Can edit',
        external_auth_id: 'ldap-editor',
        mfa_enforced: true,
      },
    });

    expect(params).toEqual({
      count: 30,
      offset: 2,
      sort: '-display_name',
      filter: {
        display_name: 'Editor',
        description: 'Can edit',
        external_auth_id: 'ldap-editor',
        mfa_enforced: 1,
      },
    });
  });

  it('leaves an omitted mfa_enforced omitted rather than defaulting it to 0', () => {
    const params = toRolesListParams({ filter: { display_name: 'Editor' } });

    expect(Object.hasOwn(params.filter ?? {}, 'mfa_enforced')).toBe(false);
    expect(params.filter).toEqual({ display_name: 'Editor' });
  });

  it('handles a query with no filter at all', () => {
    const params = toRolesListParams({ count: 20, offset: 0, sort: 'display_name' });

    expect(params).toEqual({ count: 20, offset: 0, sort: 'display_name' });
    expect(Object.hasOwn(params, 'filter')).toBe(false);
  });

  it('does not mutate its input', () => {
    const input: RolesListInput = { count: 5, filter: { mfa_enforced: false } };

    toRolesListParams(input);

    expect(input).toEqual({ count: 5, filter: { mfa_enforced: false } });
  });
});

/**
 * End of the line: what BookStack would actually receive.
 *
 * The tools are wired exactly as server.ts wires them, but pointed at a local stub that
 * records the request line. Strict validation is on, so the zod schemas - which type
 * these flags as booleans - have to accept the input before the mapper ever sees it.
 */
describe('list filters as BookStack receives them', () => {
  const noopLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as Logger;

  /** Runs `call` against a stub, returning the query BookStack was asked for. */
  async function queryFor(
    call: (tools: { pages: PageTools; roles: RoleTools }) => Promise<unknown>
  ): Promise<URLSearchParams> {
    const seen: URL[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req: Request): Response {
        seen.push(new URL(req.url));
        return new Response(JSON.stringify({ data: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    try {
      const config: Config = {
        bookstack: {
          baseUrl: `http://localhost:${server.port}/api`,
          apiToken: 'list-params-id:list-params-secret',
          timeout: 5000,
        },
        server: { name: 'bookstack-mcp-server-list-params-test', version: '1.0.0', port: 3000 },
        rateLimit: { requestsPerMinute: 60_000, burstLimit: 10_000 },
        validation: { enabled: true, strictMode: true },
        logging: { level: 'error', format: 'pretty' },
        development: { nodeEnv: 'test', debug: false },
      };

      const client = new BookStackClient(config, noopLogger, new ErrorHandler(noopLogger));
      const validator = new ValidationHandler(config.validation);

      await call({
        pages: new PageTools(client, validator, noopLogger),
        roles: new RoleTools(client, validator, noopLogger),
      });

      const url = seen[0];
      if (!url) {
        throw new Error('The stub received no request');
      }
      expect(seen).toHaveLength(1);
      return url.searchParams;
    } finally {
      server.stop(true);
    }
  }

  function callTool(
    provider: { getTools(): { name: string; handler(p: unknown): Promise<unknown> }[] },
    name: string,
    params: unknown
  ): Promise<unknown> {
    const tool = provider.getTools().find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool.handler(params);
  }

  it('sends filter[draft]=1 for draft: true', async () => {
    const query = await queryFor(({ pages }) =>
      callTool(pages, 'bookstack_pages_list', { filter: { draft: true } })
    );

    expect(query.get('filter[draft]')).toBe('1');
  });

  it('sends filter[draft]=0 - not "false" - for draft: false', async () => {
    const query = await queryFor(({ pages }) =>
      callTool(pages, 'bookstack_pages_list', { filter: { draft: false } })
    );

    // "false" would be coerced to 0 by MySQL too, and so would accidentally work
    // here - but the pair is what matters: "true" would ALSO be 0, making the two
    // requests identical. This asserts the encoding that makes them differ.
    expect(query.get('filter[draft]')).toBe('0');
    expect(query.get('filter[draft]')).not.toBe('false');
  });

  it('sends filter[template]=1 / 0 for both branches', async () => {
    const enabled = await queryFor(({ pages }) =>
      callTool(pages, 'bookstack_pages_list', { filter: { template: true } })
    );
    expect(enabled.get('filter[template]')).toBe('1');

    const disabled = await queryFor(({ pages }) =>
      callTool(pages, 'bookstack_pages_list', { filter: { template: false } })
    );
    expect(disabled.get('filter[template]')).toBe('0');
  });

  it('sends filter[mfa_enforced]=1 / 0 for both branches', async () => {
    const enforced = await queryFor(({ roles }) =>
      callTool(roles, 'bookstack_roles_list', { filter: { mfa_enforced: true } })
    );
    expect(enforced.get('filter[mfa_enforced]')).toBe('1');

    const notEnforced = await queryFor(({ roles }) =>
      callTool(roles, 'bookstack_roles_list', { filter: { mfa_enforced: false } })
    );
    expect(notEnforced.get('filter[mfa_enforced]')).toBe('0');
  });

  it('sends no draft/template filter when the caller asks for neither', async () => {
    const query = await queryFor(({ pages }) =>
      callTool(pages, 'bookstack_pages_list', { filter: { book_id: 2 } })
    );

    expect(query.get('filter[book_id]')).toBe('2');
    expect(query.has('filter[draft]')).toBe(false);
    expect(query.has('filter[template]')).toBe(false);
  });
});
