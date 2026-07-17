import type { BookStackClient } from '../api/client';
import {
  type CreateShelfParams,
  type MCPTool,
  NONBLANK_PATTERN,
  type ShelvesListParams,
  type UpdateShelfParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_shelves_update` request: the shelf to update, plus the changes. */
type UpdateShelfRequest = UpdateShelfParams & IdRequest;

/**
 * Bookshelf management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete bookshelf lifecycle management:
 * - List, create, read, update, and delete bookshelves
 */
export class ShelfTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all shelf tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListShelvesTool(),
      this.createCreateShelfTool(),
      this.createReadShelfTool(),
      this.createUpdateShelfTool(),
      this.createDeleteShelfTool(),
    ]);
  }

  /**
   * List shelves tool
   */
  private createListShelvesTool(): MCPTool {
    return {
      name: 'bookstack_shelves_list',
      description:
        'List all bookshelves visible to the authenticated user with pagination and filtering options. Shelves organize books into collections.',
      category: 'shelves',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of shelves to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of shelves to skip',
          },
          sort: {
            type: 'string',
            enum: ['name', 'created_at', 'updated_at', '-name', '-created_at', '-updated_at'],
            default: 'name',
            description: 'Sort field. Prefix with "-" to sort descending.',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Filter by shelf name. This is an exact, whole-value match, not a substring search - use bookstack_search to find shelves by partial name.',
              },
              created_by: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by creator user ID',
              },
            },
            description: 'Optional filters to apply. All filters match exactly.',
          },
        },
      },
      examples: [
        {
          description: 'List first 10 shelves',
          input: { count: 10 },
          expected_output: 'Array of shelf objects with metadata',
          use_case: 'Getting overview of available book collections',
        },
        {
          description: 'Find a shelf by its exact name',
          input: { filter: { name: 'API Documentation' } },
          expected_output: 'The shelf named exactly "API Documentation", if it exists',
          use_case: 'Resolving a known shelf name to its ID',
        },
      ],
      usage_patterns: [
        'Call first to understand book organization',
        'Use filtering to find specific collections',
        'Combine with pagination for large shelf collections',
        'List results do not include the books on each shelf; call bookstack_shelves_read for those',
      ],
      related_tools: ['bookstack_shelves_read', 'bookstack_books_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<ShelvesListParams>(
          params,
          'shelvesList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing shelves', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listShelves(validatedParams);
      },
    };
  }

  /**
   * Create shelf tool
   */
  private createCreateShelfTool(): MCPTool {
    return {
      name: 'bookstack_shelves_create',
      description:
        'Create a new bookshelf. Bookshelves are used to group related books together for better organization.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            // See NONBLANK_PATTERN: `required` upstream rejects '' and '   ' alike, and
            // `required: ['name']` on its own advertised neither.
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'Name of the shelf. Must contain a non-whitespace character.',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'Short description.',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'HTML description.',
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
          books: {
            type: 'array',
            items: {
              type: 'integer',
              minimum: 1,
            },
            description:
              'List of book IDs to put on this shelf, applied in the given order. IDs that do not exist, or that the user cannot see, are silently ignored rather than reported as an error.',
          },
        },
      },
      examples: [
        {
          description: 'Create a shelf for Project X',
          input: { name: 'Project X Documentation', books: [1, 2, 5] },
          expected_output:
            'Shelf object. Note the create response does not list the books - read the shelf to confirm which were assigned.',
          use_case: 'Grouping project-specific books',
        },
      ],
      usage_patterns: [
        'Use shelves when you have multiple books that relate to a larger theme',
        'The response omits the books property, and unknown book IDs are dropped silently, so follow up with bookstack_shelves_read to verify what actually landed on the shelf',
      ],
      related_tools: ['bookstack_books_create'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Name is missing',
          recovery_suggestion: 'Provide a name',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateShelfParams>(
          params,
          'shelfCreate'
        );
        // The name's size, not the name. See the same line in src/tools/books.ts.
        this.logger.info('Creating shelf', { name_length: validatedParams.name.length });
        return await this.client.createShelf(validatedParams);
      },
    };
  }

  /**
   * Read shelf tool
   */
  private createReadShelfTool(): MCPTool {
    return {
      name: 'bookstack_shelves_read',
      description:
        'Get details of a specific bookshelf, including the list of books assigned to it.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the shelf.',
          },
        },
      },
      examples: [
        {
          description: 'Read shelf details',
          input: { id: 3 },
          expected_output: 'Shelf object with books list',
          use_case: 'Checking contents of a collection',
        },
      ],
      usage_patterns: ['Use to find books related to a specific topic/shelf'],
      related_tools: ['bookstack_books_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Shelf not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading shelf', { id });
        return await this.client.getShelf(id);
      },
    };
  }

  /**
   * Update shelf tool
   */
  private createUpdateShelfTool(): MCPTool {
    return {
      name: 'bookstack_shelves_update',
      description:
        "Update a bookshelf's details. Can be used to rename, change description, or update the list of books on the shelf.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the shelf to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            // Upstream ACCEPTS a whitespace-only name here and blanks the entity rather
            // than erroring (verified live; see NONBLANK_PATTERN). Rejecting it is the
            // difference between a clear error and a silently destroyed name.
            pattern: NONBLANK_PATTERN,
            maxLength: 255,
            description: 'New name. Must contain a non-whitespace character.',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'New description',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'New HTML description',
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
          books: {
            type: 'array',
            items: {
              type: 'integer',
              minimum: 1,
            },
            description:
              'New list of book IDs, applied in the given order and replacing ALL existing books on this shelf. IDs that do not exist, or that the user cannot see, are silently ignored.',
          },
        },
      },
      examples: [
        {
          description: 'Update books on a shelf',
          input: { id: 3, books: [1, 5, 8] },
          expected_output:
            'Updated shelf object. Like create, the response does not list the books - read the shelf to confirm.',
          use_case: 'Reorganizing collections',
        },
      ],
      usage_patterns: [
        'To add a book to a shelf, you must read the shelf first to get the current list of books, add the new ID, and then call update with the full list.',
        'Omitting `books` entirely leaves the existing assignments untouched; passing an empty array clears them.',
      ],
      related_tools: ['bookstack_shelves_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Shelf not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema.
        const { id, ...updateParams } = this.validator.validateParams<UpdateShelfRequest>(
          params,
          'shelfUpdate'
        );
        this.logger.info('Updating shelf', {
          id,
          fields: Object.keys(updateParams),
        });
        return await this.client.updateShelf(id, updateParams);
      },
    };
  }

  /**
   * Delete shelf tool
   */
  private createDeleteShelfTool(): MCPTool {
    return {
      name: 'bookstack_shelves_delete',
      description:
        'Delete a bookshelf. This action ONLY deletes the shelf container; it does NOT delete the books that were on the shelf. The shelf is sent to the recycle bin rather than destroyed, so it can be restored until the bin is emptied.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the shelf to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete a shelf',
          input: { id: 3 },
          expected_output: 'Success message',
          use_case: 'Removing an unused collection',
        },
      ],
      usage_patterns: [
        'Safe to use without losing content (books remain safe)',
        'Recoverable: use the recycle bin tools to restore the shelf, or to purge it permanently',
      ],
      related_tools: ['bookstack_books_delete', 'bookstack_recyclebin_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Shelf not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting shelf', { id });
        await this.client.deleteShelf(id);
        return { success: true, message: `Shelf ${id} deleted successfully` };
      },
    };
  }
}
