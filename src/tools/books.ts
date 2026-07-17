import type { BookStackClient } from '../api/client';
import {
  type BooksListParams,
  type CreateBookParams,
  type MCPTool,
  NONBLANK_PATTERN,
  type UpdateBookParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { ExportRequest, IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_books_update` request: the book to update, plus the changes. */
type UpdateBookRequest = UpdateBookParams & IdRequest;

/**
 * Book management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete book lifecycle management:
 * - List, create, read, update, delete, and export books
 */
export class BookTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all book tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListBooksTools(),
      this.createCreateBookTool(),
      this.createReadBookTool(),
      this.createUpdateBookTool(),
      this.createDeleteBookTool(),
      this.createExportBookTool(),
    ]);
  }

  /**
   * List books tool
   */
  private createListBooksTools(): MCPTool {
    return {
      name: 'bookstack_books_list',
      description:
        'List all books visible to the authenticated user with pagination and filtering options. Books are the top-level containers in BookStack hierarchy.',
      category: 'books',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of books to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of books to skip',
          },
          sort: {
            type: 'string',
            enum: ['name', 'created_at', 'updated_at', '-name', '-created_at', '-updated_at'],
            default: 'name',
            description: 'Sort field. Prefix with "-" to sort descending (e.g. "-updated_at").',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Filter by book name. Matches the whole name exactly; this is NOT a substring search, so a fragment returns nothing. Use bookstack_search to find books by partial name.',
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
          description: 'List first 10 books',
          input: { count: 10 },
          expected_output: 'Array of book objects with metadata',
          use_case: 'Getting overview of available documentation',
        },
        {
          description: 'List the 5 most recently updated books',
          input: { count: 5, sort: '-updated_at' },
          expected_output: 'Books ordered newest-updated first',
          use_case: 'Finding what documentation changed most recently',
        },
      ],
      usage_patterns: [
        'Call first to understand available documentation structure',
        'Combine with pagination for large book collections',
        'To find books by topic or partial name, use bookstack_search instead - filter.name only matches a full, exact name',
      ],
      related_tools: ['bookstack_books_read', 'bookstack_search'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<BooksListParams>(params, 'booksList');
        // The filter's KEYS, not its values, and after validation rather than before: this
        // line used to hand the whole raw request to the logger, so `filter[name]` - a
        // caller's search term - was written at `debug`. See R5-W3.
        this.logger.debug('Listing books', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listBooks(validatedParams);
      },
    };
  }

  /**
   * Create book tool
   */
  private createCreateBookTool(): MCPTool {
    return {
      name: 'bookstack_books_create',
      description:
        'Create a new book in BookStack. Books are the highest level of organization and contain chapters and pages. A book must exist before you can add content to it.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            // `required` alone said only "the key must be here", so `name: ''` and
            // `name: '   '` were both legal to a client generating from this schema and
            // both rejected downstream. See NONBLANK_PATTERN for BookStack's actual rule.
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description:
              'Name of the book. Must contain a non-whitespace character. Need not be unique - BookStack happily creates two books with the same name.',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: "The book's purpose or contents, as plain text.",
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
                  description: 'Tag label (e.g., "category")',
                },
                value: {
                  type: 'string',
                  description: 'Tag value (e.g., "recipes")',
                },
              },
              required: ['name', 'value'],
            },
            description: 'Key-value pairs for categorization and filtering.',
          },
          default_template_id: {
            type: 'integer',
            minimum: 0,
            description:
              'ID of the page to pre-fill new pages in this book from. It must be a page marked as a template in BookStack and visible to you; any other page ID is silently discarded (stored as null) with no error, so verify the value on the response. The API cannot mark a page as a template - that is done in the BookStack UI.',
          },
        },
      },
      examples: [
        {
          description: 'Create a basic developer documentation book',
          input: {
            name: 'Developer Guides',
            description: 'Technical documentation for the engineering team.',
            tags: [{ name: 'Department', value: 'Engineering' }],
          },
          expected_output: 'JSON object of the created book including its new ID',
          use_case: 'Setting up a new knowledge base section',
        },
      ],
      usage_patterns: [
        'Create a book first to establish a container for chapters and pages',
        'Use tags to make the book easier to find in searches',
      ],
      related_tools: [
        'bookstack_books_list',
        'bookstack_chapters_create',
        'bookstack_pages_create',
      ],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Name is missing or too long',
          recovery_suggestion: 'Ensure name is provided and under 255 characters',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateBookParams>(
          params,
          'bookCreate'
        );
        // The name's size, not the name: an entity name is the caller's text (see R5-W3),
        // and a book title can carry a client's or a project's name.
        this.logger.info('Creating book', { name_length: validatedParams.name.length });
        return await this.client.createBook(validatedParams);
      },
    };
  }

  /**
   * Read book tool
   */
  private createReadBookTool(): MCPTool {
    return {
      name: 'bookstack_books_read',
      description:
        'Get details of a specific book including its complete content hierarchy. Use this to explore what is inside a book. The `contents` array holds the book\'s direct children, each tagged with a `type` of "chapter" or "page"; a chapter entry carries its own nested `pages` array.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the book to retrieve.',
          },
        },
      },
      examples: [
        {
          description: 'Get book structure',
          input: { id: 5 },
          expected_output: 'Book metadata plus a nested list of chapters and pages',
          use_case: 'Mapping out the structure of existing documentation',
        },
      ],
      usage_patterns: [
        'Call this to find the IDs of chapters or pages within a known book',
        'Use to check if a book is empty or has content',
      ],
      related_tools: ['bookstack_books_list', 'bookstack_chapters_read', 'bookstack_pages_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Book with the specified ID does not exist',
          recovery_suggestion: 'Check the ID from bookstack_books_list and try again',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading book', { id });
        return await this.client.getBook(id);
      },
    };
  }

  /**
   * Update book tool
   */
  private createUpdateBookTool(): MCPTool {
    return {
      name: 'bookstack_books_update',
      description:
        "Update a book's details including name, description, tags, and template settings.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the book to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            // Not merely 'not empty': a whitespace-only name is ACCEPTED by BookStack and
            // blanks the book (PUT /api/books/N {"name":"   "} -> 200, name now '').
            // See NONBLANK_PATTERN.
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'New book name. Must contain a non-whitespace character.',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'New book description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description:
              'New book description in HTML format. Takes precedence over description if both are sent.',
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
            description: 'New tags to assign (replaces existing tags).',
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
          description: 'Rename a book',
          input: { id: 5, name: 'Updated Developer Guides' },
          expected_output: 'Updated book object',
          use_case: 'Correcting a typo or renaming a project',
        },
      ],
      usage_patterns: [
        'Retrieve the book first to get current tags if you want to append, as this operation replaces all tags',
      ],
      related_tools: ['bookstack_books_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Book ID not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema.
        const { id, ...updateParams } = this.validator.validateParams<UpdateBookRequest>(
          params,
          'bookUpdate'
        );
        this.logger.info('Updating book', {
          id,
          fields: Object.keys(updateParams),
        });
        return await this.client.updateBook(id, updateParams);
      },
    };
  }

  /**
   * Delete book tool
   */
  private createDeleteBookTool(): MCPTool {
    return {
      name: 'bookstack_books_delete',
      description:
        'Delete a book. This moves the book and all its contents (chapters, pages) to the recycle bin. It can be restored later using the recycle bin tools.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the book to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete a book',
          input: { id: 5 },
          expected_output: 'Success message',
          use_case: 'Removing obsolete documentation',
        },
      ],
      usage_patterns: [
        'Use caution as this affects all child content',
        'Check recycle bin if accidental deletion occurs',
      ],
      related_tools: ['bookstack_recyclebin_list', 'bookstack_recyclebin_restore'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Book not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting book', { id });
        await this.client.deleteBook(id);
        return { success: true, message: `Book ${id} deleted successfully` };
      },
    };
  }

  /**
   * Export book tool
   */
  private createExportBookTool(): MCPTool {
    return {
      name: 'bookstack_books_export',
      description:
        'Export a book to a specific format. Useful for backups, offline reading, or migrating content. Returns { content, encoding, byte_length, filename, mime_type }: text formats arrive as-is with encoding "utf8", while "pdf" arrives base64-encoded with encoding "base64".',
      inputSchema: {
        type: 'object',
        required: ['id', 'format'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the book to export',
          },
          format: {
            type: 'string',
            enum: ['html', 'pdf', 'plaintext', 'markdown'],
            description: 'The desired export format.',
          },
        },
      },
      examples: [
        {
          description: 'Export as Markdown',
          input: { id: 5, format: 'markdown' },
          expected_output: '{ content: "# ...", encoding: "utf8", byte_length: 1234, ... }',
          use_case: 'Getting raw content for migration or git backup',
        },
      ],
      usage_patterns: [
        'Use "markdown" or "plaintext" for LLM context injection as they are more token-efficient than HTML or PDF',
        'Check `encoding` before using `content`: for "pdf" it is base64 and must be decoded to bytes, not read as text. Use `byte_length` for the real file size - `content.length` counts characters, not bytes.',
      ],
      related_tools: ['bookstack_pages_export', 'bookstack_chapters_export'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Book not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // `format` is validated, not cast: the enum is the only thing standing between a
        // typo and BookStack's export controller.
        const { id, format } = this.validator.validateParams<ExportRequest>(params, 'export');
        this.logger.info('Exporting book', { id, format });
        return await this.client.exportBook(id, format);
      },
    };
  }
}

export default BookTools;
