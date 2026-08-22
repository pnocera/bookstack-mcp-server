/**
 * Unit tests for the partial-page-editing tools.
 *
 * What is under test here is the handler behaviour the pure helpers cannot show: which field
 * gets written, that nothing is written when a guard fires, and that the responses carry no
 * page content. That last point is the feature's reason for existing - if a response echoed
 * the page back, the content would travel through the model anyway.
 *
 * The validator is REAL, not a stub. These tools lean on schema defaults (`dry_run`,
 * `position`, `context`, `max_matches`) and on `strictObject` rejecting unknown keys, so a
 * stubbed validator that waved input through would test a contract nobody ships.
 *
 * No `mock.module()`: `PageTools` takes its three collaborators via the constructor, so the
 * modules are never loaded at runtime here. Bun's module-mock registry is process-global and
 * would leak into every other file in the run.
 */

import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type { BookStackClient } from '../../src/api/client';
import { PageTools } from '../../src/tools/pages';
import type { MCPTool, PageWithContent } from '../../src/types';
import type { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';

/**
 * Types a subset of `T`'s methods, each as a bun:test `Mock` carrying its real signature.
 *
 * bun:test has no `jest.Mocked<T>` equivalent, so this derives what is needed. Deriving from
 * the real declarations keeps the stubs honest if a signature changes, while naming only the
 * methods under test keeps them robust to the client gaining unrelated ones.
 */
type MockedMethods<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

type MockClient = MockedMethods<BookStackClient, 'getPage' | 'updatePage'>;
type MockLogger = MockedMethods<Logger, 'debug' | 'info' | 'warn' | 'error'>;

const STORED = '<p>First paragraph</p><p>Second paragraph</p>';
const PAGE_ID = 42;

/**
 * A page fixture.
 *
 * `html` differs from `raw_html` on purpose here: it stands for the RENDERED output, with
 * page includes resolved. Several assertions below check that the tools read `raw_html` and
 * never `html`, since patching the rendered output would write expanded include tags back
 * into the page.
 */
const page = (overrides: Partial<PageWithContent> = {}): PageWithContent => ({
  id: PAGE_ID,
  book_id: 12,
  chapter_id: null,
  name: 'Test page',
  slug: 'test-page',
  priority: 0,
  draft: false,
  template: false,
  created_at: '2026-01-01T00:00:00.000000Z',
  updated_at: '2026-01-02T00:00:00.000000Z',
  created_by: 1,
  updated_by: 1,
  owned_by: 1,
  revision_count: 7,
  editor: 'wysiwyg',
  tags: [],
  html: '<p>rendered include</p>',
  raw_html: STORED,
  ...overrides,
});

/** The response shapes these tools return, as far as the assertions read them. */
interface GrepResult {
  total_matches: number;
  total_chars: number;
  matches: Array<{ match: string; offset: number }>;
  content?: string;
}
interface OutlineResult {
  heading_count: number;
  headings: Array<{ text: string; level: number }>;
}
interface WriteResult {
  written: boolean;
  verified: boolean;
  unverified_fragment_count: number;
  revision_count: number;
  updated_at: string;
  chars_after: number;
  delta: number;
  dry_run?: boolean;
  page_id: number;
  field: string;
  section: string | null;
}

describe('PageTools partial editing', () => {
  let pageTools: PageTools;
  let mockClient: MockClient;
  let mockLogger: MockLogger;

  const tool = (name: string): MCPTool => {
    const found = pageTools.getTools().find((candidate) => candidate.name === name);
    if (!found) {
      throw new Error(`Tool not registered: ${name}`);
    }
    return found;
  };

  /** Call a handler and read the result as the shape the assertion expects. */
  const call = async <T>(name: string, params: Record<string, unknown>): Promise<T> =>
    (await tool(name).handler(params)) as T;

  beforeEach(() => {
    mockClient = {
      getPage: mock(),
      updatePage: mock(),
    };

    mockLogger = {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
    };

    pageTools = new PageTools(
      mockClient as unknown as BookStackClient,
      new ValidationHandler({ enabled: true, strictMode: true }),
      mockLogger as unknown as Logger
    );
  });

  describe('registration', () => {
    it('publishes the six original tools plus the three editing ones', () => {
      const names = pageTools.getTools().map((candidate) => candidate.name);

      expect(names).toEqual([
        'bookstack_pages_list',
        'bookstack_pages_create',
        'bookstack_pages_read',
        'bookstack_pages_update',
        'bookstack_pages_edit',
        'bookstack_pages_append',
        'bookstack_pages_outline',
        'bookstack_pages_delete',
        'bookstack_pages_export',
      ]);
    });
  });

  describe('bookstack_pages_read', () => {
    it('returns the untouched page object when no option is set', async () => {
      // Back compatibility, asserted by identity: a plain read must be exactly what this
      // tool always returned, not a reshaped summary that happens to look similar.
      const current = page();
      mockClient.getPage.mockResolvedValue(current);

      await expect(tool('bookstack_pages_read').handler({ id: PAGE_ID })).resolves.toBe(current);
    });

    it('returns excerpts and no content when grep is used', async () => {
      mockClient.getPage.mockResolvedValue(page());

      const result = await call<GrepResult>('bookstack_pages_read', {
        id: PAGE_ID,
        grep: 'Second',
      });

      expect(result.total_matches).toBe(1);
      expect(result.matches[0].match).toBe('Second');
      expect(result.content).toBeUndefined();
      expect(result.total_chars).toBe(STORED.length);
    });

    it('greps the stored source, not the rendered html', async () => {
      // The invariant, from the outside: 'rendered' appears only in `html`. A match here
      // would mean an anchor built from a grep result could never be found on write.
      mockClient.getPage.mockResolvedValue(page());

      const result = await call<GrepResult>('bookstack_pages_read', {
        id: PAGE_ID,
        grep: 'rendered',
      });

      expect(result.total_matches).toBe(0);
    });

    it('returns size information without content for metadata_only', async () => {
      mockClient.getPage.mockResolvedValue(page());

      const result = await call<WriteResult & GrepResult>('bookstack_pages_read', {
        id: PAGE_ID,
        metadata_only: true,
      });

      expect(result.page_id).toBe(PAGE_ID);
      expect(result.field).toBe('html');
      expect(result.total_chars).toBe(STORED.length);
      expect(result.matches).toBeUndefined();
      expect(result.content).toBeUndefined();
    });

    it('rejects an unknown option rather than ignoring it', async () => {
      mockClient.getPage.mockResolvedValue(page());

      await expect(
        tool('bookstack_pages_read').handler({ id: PAGE_ID, greps: 'typo' })
      ).rejects.toThrow();
      expect(mockClient.getPage).not.toHaveBeenCalled();
    });

    it('rejects an oversized grep query before reading the page', async () => {
      await expect(
        tool('bookstack_pages_read').handler({ id: PAGE_ID, grep: 'x'.repeat(1001) })
      ).rejects.toThrow();
      expect(mockClient.getPage).not.toHaveBeenCalled();
    });
  });

  describe('bookstack_pages_outline', () => {
    it('returns headings and no page content', async () => {
      mockClient.getPage.mockResolvedValue(
        page({ raw_html: '<h2>Section A</h2><p>Text</p><h2>Section B</h2><p>Text</p>' })
      );

      const result = await call<OutlineResult>('bookstack_pages_outline', { id: PAGE_ID });

      expect(result.heading_count).toBe(2);
      expect(result.headings.map((heading) => heading.text)).toEqual(['Section A', 'Section B']);
      // The whole response, not just the headings array: this tool exists so that a large
      // page can be navigated without its body reaching the model.
      expect(JSON.stringify(result)).not.toContain('<p>Text</p>');
    });
  });

  describe('bookstack_pages_edit', () => {
    it('writes only the patched field and verifies what came back', async () => {
      mockClient.getPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(
        page({
          // As BookStack stores it: an `id` attribute it injected on save. Verification
          // has to see through that, which is why it compares normalised text.
          raw_html: '<p id="bkmrk-a">First paragraph</p><p>Third paragraph</p>',
          updated_at: '2026-01-03T00:00:00.000000Z',
          revision_count: 8,
        })
      );
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: 'Third paragraph' }],
      });

      // Exactly one field, and it is `html` - carrying the patched RAW source.
      expect(mockClient.updatePage).toHaveBeenCalledWith(PAGE_ID, {
        html: '<p>First paragraph</p><p>Third paragraph</p>',
      });
      expect(result.written).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.revision_count).toBe(8);
      expect(result.updated_at).toBe('2026-01-03T00:00:00.000000Z');
    });

    it('writes the markdown field for a markdown page', async () => {
      // Writing `html` to a markdown page switches its editor type, which a caller cannot
      // undo from the API.
      mockClient.getPage
        .mockResolvedValueOnce(page({ editor: 'markdown', markdown: '# Title\n\nOld' }))
        .mockResolvedValueOnce(page({ editor: 'markdown', markdown: '# Title\n\nNew' }));
      mockClient.updatePage.mockResolvedValue(page());

      await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Old', new_string: 'New' }],
      });

      expect(mockClient.updatePage).toHaveBeenCalledWith(PAGE_ID, {
        markdown: '# Title\n\nNew',
      });
    });

    it('writes nothing on a dry run', async () => {
      mockClient.getPage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        dry_run: true,
        edits: [{ old_string: 'Second paragraph', new_string: 'Third paragraph' }],
      });

      expect(mockClient.updatePage).not.toHaveBeenCalled();
      expect(result.dry_run).toBe(true);
      expect(result.written).toBe(false);
      // Still the pre-edit timestamp, which is what the caller passes as the next
      // expected_updated_at.
      expect(result.updated_at).toBe('2026-01-02T00:00:00.000000Z');
    });

    it('refuses to write when the page changed since it was read', async () => {
      mockClient.getPage.mockResolvedValue(page());

      await expect(
        tool('bookstack_pages_edit').handler({
          id: PAGE_ID,
          expected_updated_at: '2025-12-31T00:00:00.000000Z',
          edits: [{ old_string: 'Second paragraph', new_string: 'Third paragraph' }],
        })
      ).rejects.toThrow(/modified since it was read/);

      expect(mockClient.updatePage).not.toHaveBeenCalled();
    });

    it('refuses to write when the anchor is absent', async () => {
      mockClient.getPage.mockResolvedValue(page());

      await expect(
        tool('bookstack_pages_edit').handler({
          id: PAGE_ID,
          edits: [{ old_string: 'does not occur', new_string: 'x' }],
        })
      ).rejects.toThrow(/not found/);

      expect(mockClient.updatePage).not.toHaveBeenCalled();
    });

    it('refuses to write when the result would shrink the page drastically', async () => {
      mockClient.getPage.mockResolvedValue(page());

      await expect(
        tool('bookstack_pages_edit').handler({
          id: PAGE_ID,
          edits: [{ old_string: STORED, new_string: '<p>x</p>' }],
        })
      ).rejects.toThrow(/less than half/);

      expect(mockClient.updatePage).not.toHaveBeenCalled();
    });

    it('reports an unverified write rather than claiming success', async () => {
      // The second read returns the ORIGINAL content: the write went through but the change
      // is not in what came back. That is a real possibility - a sanitiser dropping a tag -
      // and the caller has to be told both facts: written, and not verified.
      mockClient.getPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: 'Third paragraph' }],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.unverified_fragment_count).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('does not claim a deletion was verified when the old anchor remains', async () => {
      // `new_string: ''` is an intentional deletion. If BookStack leaves the original source
      // in place, verification has to test the old anchor's absence rather than treating an
      // empty replacement as automatically present.
      mockClient.getPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: '' }],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.unverified_fragment_count).toBe(1);
    });

    it('does not claim a shrinking replacement was verified when the old anchor remains', async () => {
      mockClient.getPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: 'Second' }],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.unverified_fragment_count).toBe(1);
    });

    it('does not claim a markup-only replacement was verified when BookStack drops it', async () => {
      mockClient.getPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: '<hr>' }],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.unverified_fragment_count).toBe(1);
    });

    it('verifies a markup-only replacement when BookStack keeps the markup', async () => {
      const stored = '<p>First paragraph</p><hr>';
      mockClient.getPage
        .mockResolvedValueOnce(page())
        .mockResolvedValueOnce(page({ raw_html: stored }));
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: '<hr>' }],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.unverified_fragment_count).toBe(0);
    });

    it('verifies chained edits against the final replacement, not an intermediate anchor', async () => {
      mockClient.getPage
        .mockResolvedValueOnce(page({ html: 'c', raw_html: 'a' }))
        .mockResolvedValueOnce(page({ html: 'c', raw_html: 'c' }));
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'b', new_string: 'c' },
        ],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.unverified_fragment_count).toBe(0);
    });

    it('does not claim a chained edit was verified when the write is lost', async () => {
      mockClient.getPage.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [
          { old_string: 'Second paragraph', new_string: 'Zweiter Absatz' },
          { old_string: 'Zweiter Absatz', new_string: '' },
        ],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.unverified_fragment_count).toBe(1);
    });

    it('does not claim a markup-only replacement was verified when it already exists', async () => {
      const stored = '<p>First paragraph</p><hr><p>Second paragraph</p>';
      mockClient.getPage
        .mockResolvedValueOnce(page({ raw_html: stored }))
        .mockResolvedValueOnce(page({ raw_html: stored }));
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_edit', {
        id: PAGE_ID,
        edits: [{ old_string: 'Second paragraph', new_string: '<hr>' }],
      });

      expect(result.written).toBe(true);
      expect(result.verified).toBe(false);
      expect(result.unverified_fragment_count).toBe(1);
    });

    it('rejects an empty edit list at the schema boundary', async () => {
      await expect(
        tool('bookstack_pages_edit').handler({ id: PAGE_ID, edits: [] })
      ).rejects.toThrow();
      expect(mockClient.getPage).not.toHaveBeenCalled();
    });
  });

  describe('bookstack_pages_append', () => {
    it('appends to the end of the page', async () => {
      mockClient.getPage
        .mockResolvedValueOnce(page())
        .mockResolvedValueOnce(page({ raw_html: `${STORED}\n<p>New sentence</p>` }));
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_append', {
        id: PAGE_ID,
        content: '<p>New sentence</p>',
      });

      expect(mockClient.updatePage).toHaveBeenCalledWith(PAGE_ID, {
        html: `${STORED}\n<p>New sentence</p>`,
      });
      expect(result.verified).toBe(true);
      expect(result.delta).toBe('\n<p>New sentence</p>'.length);
      expect(result.section).toBeNull();
    });

    it('appends inside a named section', async () => {
      const withSections = '<h2>Section A</h2><p>Text</p><h2>Section B</h2><p>End</p>';
      const expected = '<h2>Section A</h2><p>Text</p>\n<p>Added</p><h2>Section B</h2><p>End</p>';
      mockClient.getPage
        .mockResolvedValueOnce(page({ raw_html: withSections }))
        .mockResolvedValueOnce(page({ raw_html: expected }));
      mockClient.updatePage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_append', {
        id: PAGE_ID,
        content: '<p>Added</p>',
        section: 'Section A',
      });

      expect(mockClient.updatePage).toHaveBeenCalledWith(PAGE_ID, { html: expected });
      expect(result.section).toBe('Section A');
    });

    it('fails with the available headings when the section is unknown', async () => {
      mockClient.getPage.mockResolvedValue(page({ raw_html: '<h2>Section A</h2><p>Text</p>' }));

      await expect(
        tool('bookstack_pages_append').handler({
          id: PAGE_ID,
          content: '<p>x</p>',
          section: 'No such section',
        })
      ).rejects.toThrow(/Section not found/);

      expect(mockClient.updatePage).not.toHaveBeenCalled();
    });

    it('writes nothing on a dry run', async () => {
      mockClient.getPage.mockResolvedValue(page());

      const result = await call<WriteResult>('bookstack_pages_append', {
        id: PAGE_ID,
        content: '<p>New sentence</p>',
        dry_run: true,
      });

      expect(mockClient.updatePage).not.toHaveBeenCalled();
      expect(result.written).toBe(false);
      expect(result.dry_run).toBe(true);
    });
  });
});
