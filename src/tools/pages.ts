import type { BookStackClient } from '../api/client';
import {
  type CreatePageParams,
  type MCPTool,
  NONBLANK_PATTERN,
  type PagesListInput,
  type PageWithContent,
  toPagesListParams,
  type UpdatePageParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import {
  applyEdits,
  assertNoUnexpectedShrink,
  buildOutline,
  containsNormalized,
  grepContent,
  insertContent,
  normalizeForComparison,
  type PageSource,
  PageStaleError,
  selectSource,
  sliceContent,
} from '../utils/page-content';
import type {
  ExportRequest,
  IdRequest,
  PageAppendRequest,
  PageEditRequest,
  PageReadRequest,
  ValidationHandler,
} from '../validation/validator';

/** The whole `bookstack_pages_update` request: the page to update, plus the changes. */
type UpdatePageRequest = UpdatePageParams & IdRequest;

/** What a post-write read must prove without requiring byte-identical HTML. */
interface WriteVerification {
  mustContain: string[];
  mustNotContain: string[];
}

/**
 * Page management tools for BookStack MCP Server
 *
 * Provides 9 tools for complete page lifecycle management:
 * - List, create, read, update, delete, and export pages
 * - Edit, append to, and outline a page WITHOUT resending its whole content
 *
 * ## Why the partial-edit tools exist
 *
 * The BookStack API offers only full replacement: `PUT /api/pages/{id}` takes a complete
 * `html` or `markdown` body and there is no PATCH. So changing one paragraph of a 40 KB page
 * meant reading all of it, having the model reproduce it verbatim with the change applied,
 * and sending it all back - which burns the content through the context twice and stakes the
 * whole page on the model copying it byte-perfectly. `bookstack_pages_edit`,
 * `bookstack_pages_append` and `bookstack_pages_outline` run that read-modify-write cycle
 * here instead, so a caller sends only the fragment it wants changed.
 *
 * Two invariants hold for any code that touches page content (see ../utils/page-content.ts):
 *
 *  - Markdown pages are patched and written through `markdown`. Writing `html` to one
 *    switches the page's editor type.
 *  - Every other page is patched against `raw_html`, the stored source - never against
 *    `html`, the rendered output. Patching the rendered output would write back expanded
 *    page-include tags and permanently destroy the includes.
 */
export class PageTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all page tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListPagesTools(),
      this.createCreatePageTool(),
      this.createReadPageTool(),
      this.createUpdatePageTool(),
      this.createEditPageTool(),
      this.createAppendPageTool(),
      this.createOutlinePageTool(),
      this.createDeletePageTool(),
      this.createExportPageTool(),
    ]);
  }

  /**
   * List pages tool
   */
  private createListPagesTools(): MCPTool {
    return {
      name: 'bookstack_pages_list',
      description:
        "List pages visible to the authenticated user, with pagination and filtering. Returns page metadata only - no page content. Use bookstack_pages_read for a single page's content.",
      category: 'pages',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of pages to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of pages to skip',
          },
          sort: {
            type: 'string',
            enum: [
              'name',
              'created_at',
              'updated_at',
              'priority',
              '-name',
              '-created_at',
              '-updated_at',
              '-priority',
            ],
            default: 'name',
            description: 'Sort field. Prefix with "-" to sort descending (e.g. "-updated_at").',
          },
          filter: {
            type: 'object',
            properties: {
              book_id: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by book ID',
              },
              chapter_id: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by chapter ID',
              },
              name: {
                type: 'string',
                description:
                  'Filter by page name. Matches the whole name exactly; this is NOT a substring search, so a fragment returns nothing. Use bookstack_search to find pages by partial name or content.',
              },
              created_by: {
                type: 'integer',
                minimum: 1,
                description:
                  'Filter by the ID of the user who created the page. Use bookstack_users_list to resolve a name to an ID.',
              },
              draft: {
                type: 'boolean',
                description:
                  'true returns only unpublished drafts, false only published pages. BookStack only ever exposes drafts owned by the authenticated user, so draft:true lists your own drafts.',
              },
              template: {
                type: 'boolean',
                description:
                  'true returns only pages marked as templates, false only non-template pages.',
              },
            },
            description: 'Optional filters to apply',
          },
        },
      },
      examples: [
        {
          description: 'List the 5 most recently updated pages',
          input: { count: 5, sort: '-updated_at' },
          expected_output: 'Page metadata ordered newest-updated first',
          use_case: 'Finding what documentation changed most recently',
        },
        {
          description: 'List the pages inside one chapter',
          input: { filter: { chapter_id: 8 } },
          expected_output: 'Pages belonging to chapter ID 8',
          use_case: 'Enumerating a section before reading or editing it',
        },
      ],
      usage_patterns: [
        'Filter by book_id or chapter_id to enumerate one container',
        'To find pages by topic, partial name or content, use bookstack_search instead - filter.name only matches a full, exact name',
      ],
      related_tools: ['bookstack_pages_read', 'bookstack_chapters_read', 'bookstack_search'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<PagesListInput>(params, 'pagesList');
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing pages', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        // draft/template are booleans to callers; BookStack's tinyint columns only
        // compare correctly against 1/0.
        return await this.client.listPages(toPagesListParams(validatedParams));
      },
    };
  }

  /**
   * Create page tool
   */
  private createCreatePageTool(): MCPTool {
    return {
      name: 'bookstack_pages_create',
      description:
        'Create a new page. Pages are the leaf nodes where actual content lives. You must provide content in either HTML or Markdown format, and specify a parent book or chapter.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          book_id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the parent book (Required if chapter_id is not provided).',
          },
          chapter_id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the parent chapter (Required if book_id is not provided).',
          },
          name: {
            type: 'string',
            // See NONBLANK_PATTERN: `required` upstream rejects '' and '   ' alike, and
            // `required: ['name']` on its own advertised neither.
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'Title of the page. Must contain a non-whitespace character.',
          },
          html: {
            type: 'string',
            description: 'Page content in HTML format. Use this OR markdown, not both.',
          },
          markdown: {
            type: 'string',
            description:
              'Page content in Markdown format. Use this OR html, not both. Preferred for LLM generation.',
          },
          tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Tag label',
                },
                value: {
                  type: 'string',
                  description: 'Tag value',
                },
              },
              required: ['name', 'value'],
            },
            description: 'Tags for categorization.',
          },
          priority: {
            type: 'integer',
            description:
              'Sort position within the parent book or chapter: lower values appear first. Left to BookStack if omitted.',
          },
        },
        // The two at-least-one rules, stated in the schema rather than only in the prose
        // above and the refinements that enforce them. `required: ['name']` was the whole
        // machine-readable contract, so a client generating a call from it saw a page with
        // no parent and no content as legal - and got a validation error back. They sit in
        // an `allOf` because both must hold and a schema carries one `anyOf`.
        //
        // BookStack states the same two rules as `required_without`
        // (`'book_id' => ['required_without:chapter_id']`, `'html' =>
        // ['required_without:markdown']`), and Laravel's `required` counts an empty string
        // as absent - hence the constraint inside the content branches rather than on the
        // properties themselves. An empty `html` does not satisfy the rule, but it is
        // still legal alongside a non-empty `markdown`.
        //
        // `minLength: 1` was an incomplete reading of that rule: it counts characters, so
        // `html: '   '` satisfied it while BookStack - which trims the body before
        // validating - rejects it. `POST /api/pages {"book_id":N,"name":"P","html":"   "}`
        // answers 422 "The html field is required when markdown is not present" on live
        // v26.05.2. See NONBLANK_PATTERN for the full derivation and evidence.
        allOf: [
          {
            anyOf: [
              { title: 'Page directly inside a book', required: ['book_id'] },
              { title: 'Page inside a chapter', required: ['chapter_id'] },
            ],
          },
          {
            anyOf: [
              {
                title: 'Content authored as HTML',
                required: ['html'],
                properties: {
                  html: { type: 'string', minLength: 1, pattern: NONBLANK_PATTERN },
                },
              },
              {
                title: 'Content authored as Markdown',
                required: ['markdown'],
                properties: {
                  markdown: { type: 'string', minLength: 1, pattern: NONBLANK_PATTERN },
                },
              },
            ],
          },
        ],
      },
      examples: [
        {
          description: 'Create a markdown page in a book',
          input: {
            book_id: 5,
            name: 'Installation Guide',
            markdown: '# Installation\n\nRun `npm install` to get started.',
          },
          expected_output: 'Created page object',
          use_case: 'Adding new documentation content',
        },
      ],
      usage_patterns: [
        'Prefer Markdown for content generation as it is more token efficient and easier to format',
        'Ensure you have the valid parent ID (book or chapter) before calling',
      ],
      related_tools: ['bookstack_books_read', 'bookstack_chapters_read', 'bookstack_pages_update'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Missing content or parent ID',
          recovery_suggestion: 'Provide html/markdown AND book_id/chapter_id',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreatePageParams>(
          params,
          'pageCreate'
        );
        // The name's size, not the name. See the same line in src/tools/books.ts - and the
        // body was never logged here, which is what the `html`/`markdown` payload rule in
        // the logger was for before the allowlist made it the default.
        this.logger.info('Creating page', {
          name_length: validatedParams.name.length,
          book_id: validatedParams.book_id,
          chapter_id: validatedParams.chapter_id,
        });
        return await this.client.createPage(validatedParams);
      },
    };
  }

  /**
   * Read page tool
   */
  private createReadPageTool(): MCPTool {
    return {
      name: 'bookstack_pages_read',
      description:
        'Get the full details and content of a page. `html` is always populated (fully rendered, with page includes resolved); `raw_html` is the unrendered stored HTML. `markdown` is only populated for pages last edited with the Markdown editor - it is an empty string for HTML-authored pages, so never treat it as the page content without checking.\n\nFor a large page, prefer the narrowing options over reading the whole thing: `grep` returns only matching excerpts (and is the way to obtain an exact `old_string` anchor for bookstack_pages_edit), `offset`/`length` return a character window, and `metadata_only` returns no content at all. Without any of them the response is the complete page object, unchanged.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the page to read.',
          },
          grep: {
            type: 'string',
            minLength: 1,
            maxLength: 1000,
            description:
              'Literal text to search for in the STORED page source. Returns matching excerpts with surrounding context instead of the whole page. Regex syntax is treated literally, so searching the stored source (not the rendered HTML) makes a returned excerpt usable verbatim as an `old_string` anchor.',
          },
          case_sensitive: {
            type: 'boolean',
            default: false,
            description: 'Match `grep` case-sensitively. Default is case-insensitive.',
          },
          context: {
            type: 'integer',
            minimum: 1,
            maximum: 2000,
            default: 200,
            description:
              'Characters of context to include on each side of a `grep` match. Widen this when the excerpt is not unique enough to anchor an edit; below roughly 40 an excerpt is rarely unique enough to use as one. The upper bound is what keeps a grep from returning the whole page.',
          },
          max_matches: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            default: 10,
            description:
              'Maximum number of `grep` excerpts to return. The response still reports the true total, so a truncated result is visible.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description:
              'Start of a character window into the stored source. Use with `length` to page through a document too large to read at once.',
          },
          length: {
            type: 'integer',
            minimum: 1,
            description: 'Length of the character window that starts at `offset`.',
          },
          metadata_only: {
            type: 'boolean',
            default: false,
            description:
              'Return only page metadata and the content size, with no content. Use to check `updated_at` or the page size before deciding how to read it.',
          },
        },
      },
      examples: [
        {
          description: 'Read a page in full',
          input: { id: 12 },
          expected_output: 'Page object with content fields',
          use_case: 'Retrieving content for analysis or update',
        },
        {
          description: 'Find an exact anchor for an edit, without loading the whole page',
          input: { id: 12, grep: 'retention period', context: 300 },
          expected_output:
            'Matching excerpts with offsets and context; no full page content in the response',
          use_case: 'Locating the text to change before calling bookstack_pages_edit',
        },
        {
          description: 'Check size and modification time before reading',
          input: { id: 12, metadata_only: true },
          expected_output: 'Page metadata plus total_chars, no content',
          use_case: 'Deciding whether a page needs windowed reading',
        },
      ],
      usage_patterns: [
        'Use this to get the "before" state of content when performing updates',
        'Useful for answering questions based on specific documentation',
        'On a large page, run `grep` first and pass the returned excerpt to bookstack_pages_edit as `old_string` - that avoids sending the page through the model twice',
        'A call with none of the narrowing options behaves exactly as before and returns the whole page',
      ],
      related_tools: [
        'bookstack_books_read',
        'bookstack_search',
        'bookstack_pages_outline',
        'bookstack_pages_edit',
      ],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
        {
          code: 'INVALID_PARAMS',
          description: '`grep` must be between 1 and 1,000 characters',
          recovery_suggestion: 'Use a shorter literal phrase from the page source.',
        },
      ],
      handler: async (params: unknown) => {
        const options = this.validator.validateParams<PageReadRequest>(params, 'pageRead');
        const { id } = options;
        this.logger.debug('Reading page', { id });

        const page = await this.client.getPage(id);

        // Back-compatible fast path: with no narrowing option set, hand back exactly the
        // object this tool has always returned. Every branch below is opt-in.
        const narrowed =
          options.grep !== undefined ||
          options.metadata_only ||
          options.offset !== undefined ||
          options.length !== undefined;
        if (!narrowed) {
          return page;
        }

        const source = selectSource(page);
        const base = {
          ...this.pageSummary(page),
          editor: source.editor,
          field: source.writeField,
          total_chars: source.source.length,
        };

        if (options.metadata_only) {
          return base;
        }

        if (options.grep !== undefined) {
          const found = grepContent(source.source, options.grep, {
            caseInsensitive: !options.case_sensitive,
            contextChars: options.context,
            maxMatches: options.max_matches,
          });
          return {
            ...base,
            pattern: options.grep,
            total_matches: found.total,
            truncated: found.truncated,
            matches: found.matches,
          };
        }

        return { ...base, ...sliceContent(source.source, options.offset ?? 0, options.length) };
      },
    };
  }

  /**
   * Update page tool
   */
  private createUpdatePageTool(): MCPTool {
    return {
      name: 'bookstack_pages_update',
      description:
        "Update a page's content or properties. Can be used to rename, rewrite content, or move the page to a different book/chapter.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to update',
          },
          book_id: {
            type: 'integer',
            minimum: 1,
            description:
              'New parent book ID. Moves the page to that book. Passing book_id on its own - with no chapter_id - is also how you pull a page out of its chapter and place it at the book root.',
          },
          chapter_id: {
            type: 'integer',
            minimum: 1,
            description:
              'New parent chapter ID. Moves the page into that chapter. There is no value that means "no chapter": 0 and negatives are rejected outright as invalid IDs, and null is rejected as not an integer. To move a page to its book root, send book_id alone instead.',
          },
          name: {
            type: 'string',
            minLength: 1,
            // Upstream ACCEPTS a whitespace-only name here and blanks the entity rather
            // than erroring (verified live; see NONBLANK_PATTERN). Rejecting it is the
            // difference between a clear error and a silently destroyed name.
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'New page name. Must contain a non-whitespace character.',
          },
          html: {
            type: 'string',
            description: 'New HTML content. Replaces existing content.',
          },
          markdown: {
            type: 'string',
            description: 'New Markdown content. Replaces existing content.',
          },
          tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Tag name',
                },
                value: {
                  type: 'string',
                  description: 'Tag value',
                },
              },
              required: ['name', 'value'],
            },
            description: 'New tags (replaces ALL existing tags).',
          },
          priority: {
            type: 'integer',
            description:
              'New sort position within the parent book or chapter: lower values appear first.',
          },
        },
      },
      examples: [
        {
          description:
            'Rewrite a page. `markdown` replaces the whole page, so to append you must resend the existing content plus the addition - read the page first.',
          input: {
            id: 12,
            markdown: '# Original Title\n\nOriginal content...\n\n## New Section\n\nAdded content.',
          },
          expected_output: 'Updated page object',
          use_case: 'Refining documentation',
        },
      ],
      usage_patterns: [
        'Always read the page first (`bookstack_pages_read`) to get current content if you intend to append or modify partially, as this tool replaces the content field entirely.',
        'To detach a page from its chapter, send `book_id` by itself; the page lands at the book root and its chapter_id becomes null.',
      ],
      related_tools: ['bookstack_pages_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema.
        const { id, ...updateParams } = this.validator.validateParams<UpdatePageRequest>(
          params,
          'pageUpdate'
        );
        this.logger.info('Updating page', {
          id,
          fields: Object.keys(updateParams),
        });
        return await this.client.updatePage(id, updateParams);
      },
    };
  }

  /**
   * Edit page tool - literal find-and-replace against the stored source.
   */
  private createEditPageTool(): MCPTool {
    return {
      name: 'bookstack_pages_edit',
      description:
        'Change parts of a page without resending the whole thing. Each edit replaces a literal `old_string` with a `new_string`; the server reads the page, applies the edits to its stored source and writes the result back.\n\n`old_string` must match EXACTLY (whitespace included) and must be unique in the page, unless `replace_all` is set - an ambiguous anchor is refused rather than applied to the wrong place. Get an exact anchor from `bookstack_pages_read` with `grep`. The response never contains the page content, only a summary of what changed.',
      category: 'pages',
      inputSchema: {
        type: 'object',
        required: ['id', 'edits'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to edit.',
          },
          edits: {
            type: 'array',
            minItems: 1,
            description:
              'Edits applied in order, each to the result of the previous one. A later edit can therefore anchor on text an earlier one introduced.',
            items: {
              type: 'object',
              required: ['old_string', 'new_string'],
              properties: {
                old_string: {
                  type: 'string',
                  minLength: 1,
                  description:
                    'Exact text to find in the stored page source, whitespace included. Must be unique unless replace_all is true. If it is not found, the error reports whether the same text exists with different whitespace.',
                },
                new_string: {
                  type: 'string',
                  description:
                    'Replacement text. The empty string deletes the anchored text. Must differ from old_string.',
                },
                replace_all: {
                  type: 'boolean',
                  default: false,
                  description:
                    'Replace every occurrence instead of requiring a unique match. Use for a rename that legitimately appears many times.',
                },
              },
            },
          },
          dry_run: {
            type: 'boolean',
            default: false,
            description:
              'Apply the edits in memory and report what WOULD change, without writing. Nothing is sent to BookStack. Use this to confirm the anchors resolve before touching the page.',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description:
              "Best-effort stale preflight: the page's `updated_at` as seen when the anchors were read. The write is refused if it has already changed when the server reads it. BookStack's API has no atomic conditional update, so this cannot prevent a change made between that read and the subsequent write.",
          },
          allow_shrink: {
            type: 'boolean',
            default: false,
            description:
              'Permit a result smaller than half the original. Off by default, so an anchor that accidentally swallows most of the document is refused rather than applied.',
          },
        },
      },
      examples: [
        {
          description: 'Check that an anchor resolves, without writing',
          input: {
            id: 12,
            edits: [
              {
                old_string: 'retention period of 6 months',
                new_string: 'retention period of 24 months',
              },
            ],
            dry_run: true,
          },
          expected_output:
            'Summary with chars_before/chars_after and the matched context; written: false',
          use_case: 'Verifying an edit before applying it',
        },
        {
          description: 'Apply the edit with a stale preflight',
          input: {
            id: 12,
            edits: [
              {
                old_string: 'retention period of 6 months',
                new_string: 'retention period of 24 months',
              },
            ],
            expected_updated_at: '2026-08-17T09:12:44.000000Z',
          },
          expected_output: 'Summary with written: true, verified: true and the new revision_count',
          use_case: 'Correcting one sentence in a long policy page',
        },
      ],
      usage_patterns: [
        'Locate the text first: bookstack_pages_read with `grep` returns excerpts you can paste straight into old_string',
        'Run with dry_run: true first on anything non-trivial - it costs no write and proves the anchors resolve',
        'Pass expected_updated_at from the read that produced your anchors to catch a page that was already stale when this server read it; BookStack cannot make this a race-free lock',
        'BookStack keeps a revision per write, so an applied edit can be rolled back in the UI',
        'Prefer this over bookstack_pages_update for partial changes: update replaces the entire content field',
      ],
      related_tools: [
        'bookstack_pages_read',
        'bookstack_pages_outline',
        'bookstack_pages_append',
        'bookstack_pages_update',
      ],
      error_codes: [
        {
          code: 'INVALID_PARAMS',
          description:
            'An anchor was not found, or matched more than once without replace_all, or the result would shrink the page by more than half',
          recovery_suggestion:
            'Read the error details: they carry the same text found with different whitespace, or the first few ambiguous matches. Widen the anchor, set replace_all, or set allow_shrink.',
        },
        {
          code: 'INVALID_REQUEST',
          description: 'The page changed since expected_updated_at',
          recovery_suggestion: 'Re-read the page, rebuild the anchors and retry',
        },
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const options = this.validator.validateParams<PageEditRequest>(params, 'pageEdit');
        const { id } = options;

        const page = await this.client.getPage(id);
        this.assertNotStale(page, options.expected_updated_at);

        const source = selectSource(page);
        const { result, applied } = applyEdits(source.source, options.edits);
        assertNoUnexpectedShrink(source.source, result, options.allow_shrink);

        const summary = {
          ...this.pageSummary(page),
          editor: source.editor,
          field: source.writeField,
          chars_before: source.source.length,
          chars_after: result.length,
          delta: result.length - source.source.length,
          edits: applied,
        };

        if (options.dry_run) {
          return {
            ...summary,
            dry_run: true,
            written: false,
            hint: 'Re-run without dry_run to apply these edits.',
          };
        }

        this.logger.info('Editing page', { id, edit_count: options.edits.length });

        return {
          ...summary,
          ...(await this.writeAndVerify(page, source, result, {
            mustContain: options.edits
              // A later edit may have replaced text an earlier edit introduced. Require only
              // fragments that remain in the final source, otherwise a correct chained write
              // would be reported as unverified.
              .filter((edit) => edit.new_string.length > 0 && result.includes(edit.new_string))
              .map((edit) => edit.new_string),
            mustNotContain: options.edits
              // When a replacement is already present in the original source, finding it after
              // the write does not prove this edit landed. In that case also require the old
              // anchor's absence, provided a later edit did not deliberately restore it.
              .filter(
                (edit) =>
                  !result.includes(edit.old_string) &&
                  (edit.new_string.length === 0 ||
                    (normalizeForComparison(edit.new_string, source.writeField).length > 0 &&
                      containsNormalized(source.source, edit.new_string, source.writeField)))
              )
              .map((edit) => edit.old_string),
          })),
        };
      },
    };
  }

  /**
   * Append page tool - insert a fragment at a page or section boundary.
   */
  private createAppendPageTool(): MCPTool {
    return {
      name: 'bookstack_pages_append',
      description:
        'Add content to a page without resending the existing content. Appends to the end of the page by default, or to the end of a named section, or directly after a section heading with `position: "start"`.\n\nSection names come from `bookstack_pages_outline`; matching is case-insensitive and falls back to a substring match. The response never contains the page content.',
      category: 'pages',
      inputSchema: {
        type: 'object',
        required: ['id', 'content'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to append to.',
          },
          content: {
            type: 'string',
            minLength: 1,
            description:
              "Content to insert, in the page's own format - Markdown for a page authored in the Markdown editor, HTML otherwise. Check `editor` via bookstack_pages_outline if unsure.",
          },
          position: {
            type: 'string',
            enum: ['start', 'end'],
            default: 'end',
            description:
              'Where to insert within the target range. "end" appends at the end of the page or section; "start" inserts directly AFTER the section heading, which is how you add a lead paragraph to a section.',
          },
          section: {
            type: 'string',
            minLength: 1,
            description:
              'Heading text of the section to insert into. Omit to target the whole page. If no heading matches, the error lists the available section names.',
          },
          separator: {
            type: 'string',
            description:
              'Text placed between the existing content and the insertion. Defaults to a blank line for Markdown pages and a single newline otherwise. Set to an empty string to join without a break.',
          },
          dry_run: {
            type: 'boolean',
            default: false,
            description: 'Report what would change without writing anything.',
          },
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description:
              "Best-effort stale preflight: reject if the page is already changed when the server reads it. This is not an atomic lock because BookStack's update API accepts no version precondition.",
          },
        },
      },
      examples: [
        {
          description: 'Append a paragraph to the end of a page',
          input: { id: 12, content: '<p>Reviewed in August 2026.</p>' },
          expected_output: 'Summary with written: true and the character delta',
          use_case: 'Adding a note without touching existing content',
        },
        {
          description: 'Add a row to a specific section',
          input: {
            id: 12,
            section: 'Change log',
            content: '<p>2026-08-17: retention extended.</p>',
          },
          expected_output: 'Summary naming the section that was appended to',
          use_case: 'Maintaining a log section in a long document',
        },
      ],
      usage_patterns: [
        'Call bookstack_pages_outline first to get exact section names and see which editor the page uses',
        'Match the page format: HTML for a wysiwyg page, Markdown for a markdown page - mixing them produces visible markup',
        'Use position: "start" to introduce a section, "end" to add to it',
        'This never rewrites existing content, so it is the safe choice for adding to a page you have not read',
      ],
      related_tools: ['bookstack_pages_outline', 'bookstack_pages_edit', 'bookstack_pages_read'],
      error_codes: [
        {
          code: 'INVALID_PARAMS',
          description: 'The named section does not exist',
          recovery_suggestion:
            'The error details list the available section names; use one of those or omit `section` to append to the page',
        },
        {
          code: 'INVALID_REQUEST',
          description: 'The page changed since expected_updated_at',
          recovery_suggestion: 'Re-read the page and retry',
        },
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const options = this.validator.validateParams<PageAppendRequest>(params, 'pageAppend');
        const { id } = options;

        const page = await this.client.getPage(id);
        this.assertNotStale(page, options.expected_updated_at);

        const source = selectSource(page);
        const result = insertContent(source.source, options.content, {
          position: options.position,
          ...(options.section !== undefined ? { section: options.section } : {}),
          ...(options.separator !== undefined ? { separator: options.separator } : {}),
          writeField: source.writeField,
        });

        const summary = {
          ...this.pageSummary(page),
          editor: source.editor,
          field: source.writeField,
          position: options.position,
          section: options.section ?? null,
          chars_before: source.source.length,
          chars_after: result.length,
          delta: result.length - source.source.length,
        };

        if (options.dry_run) {
          return {
            ...summary,
            dry_run: true,
            written: false,
            hint: 'Re-run without dry_run to apply this insertion.',
          };
        }

        this.logger.info('Appending to page', { id, position: options.position });

        return {
          ...summary,
          ...(await this.writeAndVerify(page, source, result, {
            mustContain: [options.content],
            mustNotContain: [],
          })),
        };
      },
    };
  }

  /**
   * Outline page tool - the heading structure, without the content.
   */
  private createOutlinePageTool(): MCPTool {
    return {
      name: 'bookstack_pages_outline',
      description:
        "Map a page's heading structure without transferring its content. Returns each heading with its level, exact text, character offset and section size, plus which editor the page uses.\n\nThis is the cheap first step for working on a large page: it tells you what sections exist (for `bookstack_pages_append`), how big each one is, and whether the page is HTML or Markdown.",
      category: 'pages',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to outline.',
          },
        },
      },
      examples: [
        {
          description: 'Inspect the structure of a long page',
          input: { id: 12 },
          expected_output:
            'editor, field, total_chars, heading_count and a headings array with level/text/offset/length',
          use_case: 'Deciding which section to edit or append to',
        },
      ],
      usage_patterns: [
        'Run this before bookstack_pages_append to get exact section names',
        'The `length` of a heading is the size of its section, which shows where the content actually sits',
        'Check `editor` before writing: it decides whether content must be HTML or Markdown',
        'A page with no headings returns an empty array - that is not an error',
      ],
      related_tools: ['bookstack_pages_read', 'bookstack_pages_append', 'bookstack_pages_edit'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Outlining page', { id });

        const page = await this.client.getPage(id);
        const source = selectSource(page);
        const headings = buildOutline(source.source, source.writeField);

        return {
          ...this.pageSummary(page),
          editor: source.editor,
          field: source.writeField,
          total_chars: source.source.length,
          heading_count: headings.length,
          headings,
        };
      },
    };
  }

  /**
   * The page facts the partial-edit tools report back.
   *
   * Carries no page content. These tools exist to keep page content out of the model, so a
   * response that echoed it back would undo the saving. `updated_at` is included because it
   * is the value a caller passes as the next `expected_updated_at`.
   */
  private pageSummary(page: PageWithContent): Record<string, unknown> {
    return {
      page_id: page.id,
      name: page.name,
      slug: page.slug,
      book_id: page.book_id,
      chapter_id: page.chapter_id,
      updated_at: page.updated_at,
      revision_count: page.revision_count,
    };
  }

  /**
   * Refuse a write if the page had already moved when this server read it.
   *
   * Compared as strings against what BookStack reported, not as parsed dates: the API's
   * microsecond precision survives a round trip, and parsing would introduce a way for two
   * different timestamps to compare equal. This remains a preflight, not a lock: BookStack
   * accepts an unconditional PUT, so another actor can still write after this comparison.
   */
  private assertNotStale(page: PageWithContent, expectedUpdatedAt?: string): void {
    if (expectedUpdatedAt === undefined || expectedUpdatedAt === page.updated_at) {
      return;
    }

    throw new PageStaleError('Page was modified since it was read', {
      expected_updated_at: expectedUpdatedAt,
      actual_updated_at: page.updated_at,
      hint: 'Re-read the page, rebuild your anchors against the new content and retry.',
    });
  }

  /**
   * Write the patched source back, then read the page again and confirm the change landed.
   *
   * The re-read is not paranoia about the network - it is about BookStack rewriting what it
   * stores. On save it re-generates heading anchors and injects `id` attributes, so the bytes
   * that come back are not the bytes that were sent. Verification therefore compares
   * NORMALISED text (see containsNormalized), and a fragment that cannot be found is reported
   * as `verified: false` rather than thrown: the write did happen, and the caller needs to
   * know both facts.
   */
  private async writeAndVerify(
    page: PageWithContent,
    source: PageSource,
    result: string,
    verification: WriteVerification
  ): Promise<Record<string, unknown>> {
    await this.client.updatePage(page.id, { [source.writeField]: result });

    const written = await this.client.getPage(page.id);
    const writtenSource = selectSource(written);
    const missing = verification.mustContain.filter((fragment) => {
      const normalized = normalizeForComparison(fragment, writtenSource.writeField);
      if (normalized.length === 0) {
        // HTML-to-text intentionally removes markup-only fragments (`<hr>`, `<img>`, etc.).
        // They still need a structural post-write check, otherwise a stored fragment would be
        // reported as missing forever; collapse formatting whitespace but require the literal
        // markup to remain present.
        const collapseWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();
        return !collapseWhitespace(writtenSource.source).includes(collapseWhitespace(fragment));
      }
      return !containsNormalized(writtenSource.source, fragment, writtenSource.writeField);
    });
    // An empty replacement deletes its old anchor. An empty normalised anchor cannot be
    // meaningfully searched for, so treat it as unverified rather than claiming success.
    const stillPresent = verification.mustNotContain.filter((fragment) => {
      const normalized = normalizeForComparison(fragment, writtenSource.writeField);
      return (
        normalized.length === 0 ||
        containsNormalized(writtenSource.source, fragment, writtenSource.writeField)
      );
    });
    const unverifiedCount = missing.length + stillPresent.length;

    if (unverifiedCount > 0) {
      // Not an error: the page WAS written. But a fragment we cannot find afterwards means
      // BookStack transformed it beyond recognition (a sanitiser dropping a tag, say), and
      // that is worth an operator's attention. Count only - the fragments are page content.
      this.logger.warn('Page write could not be verified', {
        page_id: page.id,
        unverified_fragment_count: unverifiedCount,
      });
    }

    return {
      written: true,
      verified: unverifiedCount === 0,
      unverified_fragment_count: unverifiedCount,
      updated_at: written.updated_at,
      revision_count: written.revision_count,
      chars_stored: writtenSource.source.length,
    };
  }

  /**
   * Delete page tool
   */
  private createDeletePageTool(): MCPTool {
    return {
      name: 'bookstack_pages_delete',
      description: 'Move a page to the recycle bin. It can be restored later if needed.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete a page',
          input: { id: 12 },
          expected_output: 'Success message',
          use_case: 'Removing outdated info',
        },
      ],
      usage_patterns: ['Check recycle bin to restore if needed'],
      related_tools: ['bookstack_recyclebin_restore'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting page', { id });
        await this.client.deletePage(id);
        return { success: true, message: `Page ${id} deleted successfully` };
      },
    };
  }

  /**
   * Export page tool
   */
  private createExportPageTool(): MCPTool {
    return {
      name: 'bookstack_pages_export',
      description:
        'Export a page to a specific format (HTML, PDF, Markdown, Plain Text). Returns { content, encoding, byte_length, filename, mime_type }: text formats arrive as-is with encoding "utf8", while "pdf" arrives base64-encoded with encoding "base64".',
      inputSchema: {
        type: 'object',
        required: ['id', 'format'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to export',
          },
          format: {
            type: 'string',
            enum: ['html', 'pdf', 'plaintext', 'markdown'],
            description: 'Desired format.',
          },
        },
      },
      examples: [
        {
          description: 'Get markdown content',
          input: { id: 12, format: 'markdown' },
          expected_output: '{ content: "# ...", encoding: "utf8", byte_length: 1234, ... }',
          use_case: 'Extracting content for processing',
        },
      ],
      usage_patterns: [
        'Use "plaintext" or "markdown" for processing text in LLMs',
        'Check `encoding` before using `content`: for "pdf" it is base64 and must be decoded to bytes, not read as text. Use `byte_length` for the real file size - `content.length` counts characters, not bytes.',
      ],
      related_tools: ['bookstack_books_export'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // `format` is validated, not cast: the enum is the only thing standing between a
        // typo and BookStack's export controller.
        const { id, format } = this.validator.validateParams<ExportRequest>(params, 'export');
        this.logger.info('Exporting page', { id, format });
        return await this.client.exportPage(id, format);
      },
    };
  }
}

export default PageTools;
