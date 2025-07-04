import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

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
    return [
      this.createListShelvesTool(),
      this.createCreateShelfTool(),
      this.createReadShelfTool(),
      this.createUpdateShelfTool(),
      this.createDeleteShelfTool(),
    ];
  }

  /**
   * List shelves tool
   */
  private createListShelvesTool(): MCPTool {
    return {
      name: 'bookstack_shelves_list',
      description: 'List all bookshelves visible to the authenticated user with pagination and filtering options. Shelves organize books into collections.',
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
            enum: ['name', 'created_at', 'updated_at'],
            default: 'name',
            description: 'Sort field',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by shelf name (partial match)',
              },
              created_by: {
                type: 'integer',
                description: 'Filter by creator user ID',
              },
            },
            description: 'Optional filters to apply',
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
          description: 'Search for API-related shelves',
          input: { filter: { name: 'api' } },
          expected_output: 'Shelves containing "api" in their name',
          use_case: 'Finding specific topic collections',
        },
      ],
      usage_patterns: [
        'Call first to understand book organization',
        'Use filtering to find specific collections',
        'Combine with pagination for large shelf collections',
      ],
      related_tools: ['bookstack_shelves_read', 'bookstack_books_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing shelves', params);
        const validatedParams = this.validator.validateParams<any>(params, 'shelvesList');
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
      description: 'Create a new bookshelf with name, description, and tags',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
            description: 'Shelf name (required)',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'Shelf description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'Shelf description in HTML format',
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
            description: 'Array of tags to assign to the shelf',
          },
          books: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'Array of book IDs to add to the shelf',
          },
        },
      },
      handler: async (params: any) => {
        this.logger.info('Creating shelf', { name: params.name });
        const validatedParams = this.validator.validateParams<any>(params, 'shelfCreate');
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
      description: 'Get details of a specific bookshelf including all its books and their structure',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Shelf ID to retrieve',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Update a bookshelf\'s details including name, description, tags, and book collection',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Shelf ID to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New shelf name',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'New shelf description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'New shelf description in HTML format',
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
            description: 'New tags to assign to the shelf (replaces existing tags)',
          },
          books: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'New array of book IDs for the shelf (replaces existing books)',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating shelf', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'shelfUpdate');
        return await this.client.updateShelf(id, validatedParams);
      },
    };
  }

  /**
   * Delete shelf tool
   */
  private createDeleteShelfTool(): MCPTool {
    return {
      name: 'bookstack_shelves_delete',
      description: 'Delete a bookshelf (books are not deleted, only removed from the shelf)',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Shelf ID to delete',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.warn('Deleting shelf', { id });
        await this.client.deleteShelf(id);
        return { success: true, message: `Shelf ${id} deleted successfully` };
      },
    };
  }
}