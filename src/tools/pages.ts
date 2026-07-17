import type { BookStackClient } from '../api/client';
import {
  type CreatePageParams,
  type MCPTool,
  NONBLANK_PATTERN,
  type PagesListInput,
  toPagesListParams,
  type UpdatePageParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { ExportRequest, IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_pages_update` request: the page to update, plus the changes. */
type UpdatePageRequest = UpdatePageParams & IdRequest;

/**
 * Page management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete page lifecycle management:
 * - List, create, read, update, delete, and export pages
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
        'Get the full details and content of a page. `html` is always populated (fully rendered, with page includes resolved); `raw_html` is the unrendered stored HTML. `markdown` is only populated for pages last edited with the Markdown editor - it is an empty string for HTML-authored pages, so never treat it as the page content without checking.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the page to read.',
          },
        },
      },
      examples: [
        {
          description: 'Read a page',
          input: { id: 12 },
          expected_output: 'Page object with content fields',
          use_case: 'Retrieving content for analysis or update',
        },
      ],
      usage_patterns: [
        'Use this to get the "before" state of content when performing updates',
        'Useful for answering questions based on specific documentation',
      ],
      related_tools: ['bookstack_books_read', 'bookstack_search'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading page', { id });
        return await this.client.getPage(id);
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
