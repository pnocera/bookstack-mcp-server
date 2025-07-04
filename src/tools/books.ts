import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

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
    return [
      this.createListBooksTools(),
      this.createCreateBookTool(),
      this.createReadBookTool(),
      this.createUpdateBookTool(),
      this.createDeleteBookTool(),
      this.createExportBookTool(),
    ];
  }

  /**
   * List books tool
   */
  private createListBooksTools(): MCPTool {
    return {
      name: 'bookstack_books_list',
      description: 'List all books visible to the authenticated user with pagination and filtering options. Books are the top-level containers in BookStack hierarchy.',
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
            enum: ['name', 'created_at', 'updated_at'],
            default: 'name',
            description: 'Sort field',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by book name (partial match)',
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
          description: 'List first 10 books',
          input: { count: 10 },
          expected_output: 'Array of book objects with metadata',
          use_case: 'Getting overview of available documentation',
        },
        {
          description: 'Search for API-related books',
          input: { filter: { name: 'api' } },
          expected_output: 'Books containing "api" in their name',
          use_case: 'Finding specific documentation topics',
        },
      ],
      usage_patterns: [
        'Call first to understand available documentation structure',
        'Use filtering to find specific topic areas',
        'Combine with pagination for large book collections',
      ],
      related_tools: ['bookstack_books_read', 'bookstack_search_books'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing books', params);
        const validatedParams = this.validator.validateParams<any>(params, 'booksList');
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
      description: 'Create a new book with name, description, tags, and template settings',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
            description: 'Book name (required)',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'Book description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'Book description in HTML format',
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
            description: 'Array of tags to assign to the book',
          },
          default_template_id: {
            type: 'integer',
            description: 'ID of default page template for new pages in this book',
          },
        },
      },
      handler: async (params: any) => {
        this.logger.info('Creating book', { name: params.name });
        const validatedParams = this.validator.validateParams<any>(params, 'bookCreate');
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
      description: 'Get details of a specific book including its complete content hierarchy (chapters and pages)',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Book ID to retrieve',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Update a book\'s details including name, description, tags, and template settings',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Book ID to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New book name',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'New book description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'New book description in HTML format',
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
            description: 'New tags to assign to the book (replaces existing tags)',
          },
          default_template_id: {
            type: 'integer',
            description: 'New default page template ID',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating book', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'bookUpdate');
        return await this.client.updateBook(id, validatedParams);
      },
    };
  }

  /**
   * Delete book tool
   */
  private createDeleteBookTool(): MCPTool {
    return {
      name: 'bookstack_books_delete',
      description: 'Delete a book (moves to recycle bin where it can be restored)',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Book ID to delete',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Export a book in various formats (HTML, PDF, plain text, or Markdown)',
      inputSchema: {
        type: 'object',
        required: ['id', 'format'],
        properties: {
          id: {
            type: 'integer',
            description: 'Book ID to export',
          },
          format: {
            type: 'string',
            enum: ['html', 'pdf', 'plaintext', 'markdown'],
            description: 'Export format',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        const { format } = params;
        this.logger.info('Exporting book', { id, format });
        return await this.client.exportBook(id, format);
      },
    };
  }
}

export default BookTools;