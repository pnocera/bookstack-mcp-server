import type { BookStackClient } from '../api/client';
import {
  type ChaptersListParams,
  type CreateChapterParams,
  type MCPTool,
  NONBLANK_PATTERN,
  type UpdateChapterParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { ExportRequest, IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_chapters_update` request: the chapter to update, plus the changes. */
type UpdateChapterRequest = UpdateChapterParams & IdRequest;

/**
 * Chapter management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete chapter lifecycle management:
 * - List, create, read, update, delete, and export chapters
 */
export class ChapterTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all chapter tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListChaptersTool(),
      this.createCreateChapterTool(),
      this.createReadChapterTool(),
      this.createUpdateChapterTool(),
      this.createDeleteChapterTool(),
      this.createExportChapterTool(),
    ]);
  }

  /**
   * List chapters tool
   */
  private createListChaptersTool(): MCPTool {
    return {
      name: 'bookstack_chapters_list',
      description:
        'List all chapters visible to the authenticated user with pagination and filtering options. Chapters are organizational containers within books.',
      category: 'chapters',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of chapters to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of chapters to skip',
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
              name: {
                type: 'string',
                description:
                  'Filter by chapter name. Matches the whole name exactly; this is NOT a substring search, so a fragment returns nothing. Use bookstack_search to find chapters by partial name.',
              },
              created_by: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by creator user ID',
              },
            },
            description: 'Optional filters to apply',
          },
        },
      },
      examples: [
        {
          description: 'List first 10 chapters',
          input: { count: 10 },
          expected_output: 'Array of chapter objects with metadata',
          use_case: 'Getting overview of chapter structure',
        },
        {
          description: 'Find chapters in specific book',
          input: { filter: { book_id: 5 } },
          expected_output: 'Chapters belonging to book ID 5',
          use_case: 'Exploring book organization',
        },
      ],
      usage_patterns: [
        'Use before reading specific chapters',
        'Filter by book_id to see book structure',
        'Combine with pagination for large chapter collections',
        'To find chapters by topic or partial name, use bookstack_search instead - filter.name only matches a full, exact name',
      ],
      related_tools: ['bookstack_chapters_read', 'bookstack_books_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<ChaptersListParams>(
          params,
          'chaptersList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing chapters', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listChapters(validatedParams);
      },
    };
  }

  /**
   * Create chapter tool
   */
  private createCreateChapterTool(): MCPTool {
    return {
      name: 'bookstack_chapters_create',
      description:
        'Create a new chapter within a book. Chapters are used to group related pages together.',
      inputSchema: {
        type: 'object',
        required: ['book_id', 'name'],
        properties: {
          book_id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the book that will contain this chapter.',
          },
          name: {
            type: 'string',
            // See NONBLANK_PATTERN: `required` upstream rejects '' and '   ' alike, and
            // `required: ['name']` on its own advertised neither.
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'Name of the chapter. Must contain a non-whitespace character.',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'Short description of the chapter contents, as plain text.',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description:
              'HTML formatted description. Takes precedence over description: if both are sent, the plain-text description is overwritten with the text extracted from this HTML.',
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
            description: 'Tags for categorization.',
          },
          priority: {
            type: 'integer',
            description:
              'Sort position within the book: lower values appear first. Left to BookStack if omitted.',
          },
          default_template_id: {
            type: 'integer',
            minimum: 0,
            description:
              'ID of the page to pre-fill new pages in this chapter from. It must be a page marked as a template in BookStack and visible to you; any other page ID is silently discarded (stored as null) with no error, so verify the value on the response. The API cannot mark a page as a template - that is done in the BookStack UI.',
          },
        },
      },
      examples: [
        {
          description: 'Create a chapter',
          input: { book_id: 5, name: 'Advanced Configuration' },
          expected_output: 'Chapter object',
          use_case: 'Structuring a book',
        },
      ],
      usage_patterns: ['Organize pages into chapters when a book becomes too large or flat'],
      related_tools: ['bookstack_books_read', 'bookstack_pages_create'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Invalid book_id or missing name',
          recovery_suggestion: 'Verify inputs',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateChapterParams>(
          params,
          'chapterCreate'
        );
        // The name's size, not the name. See the same line in src/tools/books.ts.
        this.logger.info('Creating chapter', {
          name_length: validatedParams.name.length,
          book_id: validatedParams.book_id,
        });
        return await this.client.createChapter(validatedParams);
      },
    };
  }

  /**
   * Read chapter tool
   */
  private createReadChapterTool(): MCPTool {
    return {
      name: 'bookstack_chapters_read',
      description:
        'Get details of a specific chapter, including a list of pages contained within it.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the chapter.',
          },
        },
      },
      examples: [
        {
          description: 'Read chapter details',
          input: { id: 8 },
          expected_output: 'Chapter object with pages list',
          use_case: 'Listing pages in a specific section',
        },
      ],
      usage_patterns: ['Use to find page IDs within a chapter'],
      related_tools: ['bookstack_pages_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Chapter not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading chapter', { id });
        return await this.client.getChapter(id);
      },
    };
  }

  /**
   * Update chapter tool
   */
  private createUpdateChapterTool(): MCPTool {
    return {
      name: 'bookstack_chapters_update',
      description:
        "Update a chapter's details. Can be used to rename, change description, or move to a different book.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the chapter to update',
          },
          book_id: {
            type: 'integer',
            minimum: 1,
            description: 'New parent book ID (Use to move the chapter)',
          },
          name: {
            type: 'string',
            minLength: 1,
            // Upstream ACCEPTS a whitespace-only name here and blanks the entity rather
            // than erroring (verified live; see NONBLANK_PATTERN). Rejecting it is the
            // difference between a clear error and a silently destroyed name.
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'New chapter name. Must contain a non-whitespace character.',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'New description, as plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description:
              'New HTML description. Takes precedence over description if both are sent.',
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
            description: 'New tags (replaces ALL existing tags)',
          },
          priority: {
            type: 'integer',
            description: 'New sort position within the book: lower values appear first.',
          },
          default_template_id: {
            type: 'integer',
            minimum: 0,
            description:
              'New default page template ID. Must be a page marked as a template in BookStack and visible to you; any other page ID is silently discarded (stored as null) with no error. Send 0 to clear the current default template.',
          },
        },
      },
      examples: [
        {
          description: 'Rename a chapter',
          input: { id: 8, name: 'Renamed Chapter' },
          expected_output: 'Updated chapter object',
          use_case: 'Correcting titles',
        },
      ],
      usage_patterns: ['To append tags, read the chapter first to get existing tags'],
      related_tools: ['bookstack_chapters_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Chapter not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema.
        const { id, ...updateParams } = this.validator.validateParams<UpdateChapterRequest>(
          params,
          'chapterUpdate'
        );
        this.logger.info('Updating chapter', {
          id,
          fields: Object.keys(updateParams),
        });
        return await this.client.updateChapter(id, updateParams);
      },
    };
  }

  /**
   * Delete chapter tool
   */
  private createDeleteChapterTool(): MCPTool {
    return {
      name: 'bookstack_chapters_delete',
      description: 'Move a chapter and all its child pages to the recycle bin.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the chapter to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete a chapter',
          input: { id: 8 },
          expected_output: 'Success message',
          use_case: 'Removing a whole section',
        },
      ],
      usage_patterns: ['WARNING: This also deletes all pages within the chapter. Use caution.'],
      related_tools: ['bookstack_recyclebin_restore'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Chapter not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting chapter', { id });
        await this.client.deleteChapter(id);
        return { success: true, message: `Chapter ${id} deleted successfully` };
      },
    };
  }

  /**
   * Export chapter tool
   */
  private createExportChapterTool(): MCPTool {
    return {
      name: 'bookstack_chapters_export',
      description:
        'Export a chapter to a specific format. Includes content from all pages in the chapter. Returns { content, encoding, byte_length, filename, mime_type }: text formats arrive as-is with encoding "utf8", while "pdf" arrives base64-encoded with encoding "base64".',
      inputSchema: {
        type: 'object',
        required: ['id', 'format'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the chapter to export',
          },
          format: {
            type: 'string',
            enum: ['html', 'pdf', 'plaintext', 'markdown'],
            description: 'Desired format',
          },
        },
      },
      examples: [
        {
          description: 'Export chapter as PDF',
          input: { id: 8, format: 'pdf' },
          expected_output: '{ content: "<base64>", encoding: "base64", byte_length: 879000, ... }',
          use_case: 'Creating a printable section guide',
        },
      ],
      usage_patterns: [
        'Use "plaintext" or "markdown" for LLM context injection',
        'Check `encoding` before using `content`: for "pdf" it is base64 and must be decoded to bytes, not read as text. Use `byte_length` for the real file size - `content.length` counts characters, not bytes.',
      ],
      related_tools: ['bookstack_books_export'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Chapter not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // `format` is validated, not cast: the enum is the only thing standing between a
        // typo and BookStack's export controller.
        const { id, format } = this.validator.validateParams<ExportRequest>(params, 'export');
        this.logger.info('Exporting chapter', { id, format });
        return await this.client.exportChapter(id, format);
      },
    };
  }
}
