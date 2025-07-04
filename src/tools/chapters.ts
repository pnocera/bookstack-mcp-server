import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

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
    return [
      this.createListChaptersTool(),
      this.createCreateChapterTool(),
      this.createReadChapterTool(),
      this.createUpdateChapterTool(),
      this.createDeleteChapterTool(),
      this.createExportChapterTool(),
    ];
  }

  /**
   * List chapters tool
   */
  private createListChaptersTool(): MCPTool {
    return {
      name: 'bookstack_chapters_list',
      description: 'List all chapters visible to the authenticated user with pagination and filtering options. Chapters are organizational containers within books.',
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
            enum: ['name', 'created_at', 'updated_at', 'priority'],
            default: 'name',
            description: 'Sort field',
          },
          filter: {
            type: 'object',
            properties: {
              book_id: {
                type: 'integer',
                description: 'Filter by book ID',
              },
              name: {
                type: 'string',
                description: 'Filter by chapter name (partial match)',
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
      ],
      related_tools: ['bookstack_chapters_read', 'bookstack_books_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing chapters', params);
        const validatedParams = this.validator.validateParams<any>(params, 'chaptersList');
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
      description: 'Create a new chapter within a book with name, description, tags, and priority settings',
      inputSchema: {
        type: 'object',
        required: ['book_id', 'name'],
        properties: {
          book_id: {
            type: 'integer',
            description: 'Parent book ID (required)',
          },
          name: {
            type: 'string',
            maxLength: 255,
            description: 'Chapter name (required)',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'Chapter description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'Chapter description in HTML format',
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
            description: 'Array of tags to assign to the chapter',
          },
          priority: {
            type: 'integer',
            description: 'Chapter priority for ordering within book',
          },
        },
      },
      handler: async (params: any) => {
        this.logger.info('Creating chapter', { name: params.name, book_id: params.book_id });
        const validatedParams = this.validator.validateParams<any>(params, 'chapterCreate');
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
      description: 'Get details of a specific chapter including all its pages and complete structure',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Chapter ID to retrieve',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Update a chapter\'s details including name, description, tags, and priority',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Chapter ID to update',
          },
          book_id: {
            type: 'integer',
            description: 'Move chapter to different book',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New chapter name',
          },
          description: {
            type: 'string',
            maxLength: 1900,
            description: 'New chapter description in plain text',
          },
          description_html: {
            type: 'string',
            maxLength: 2000,
            description: 'New chapter description in HTML format',
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
            description: 'New tags to assign to the chapter (replaces existing tags)',
          },
          priority: {
            type: 'integer',
            description: 'New chapter priority for ordering',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating chapter', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'chapterUpdate');
        return await this.client.updateChapter(id, validatedParams);
      },
    };
  }

  /**
   * Delete chapter tool
   */
  private createDeleteChapterTool(): MCPTool {
    return {
      name: 'bookstack_chapters_delete',
      description: 'Delete a chapter and all its pages (moves to recycle bin where it can be restored)',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'Chapter ID to delete',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Export a chapter and all its pages in various formats (HTML, PDF, plain text, or Markdown)',
      inputSchema: {
        type: 'object',
        required: ['id', 'format'],
        properties: {
          id: {
            type: 'integer',
            description: 'Chapter ID to export',
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
        this.logger.info('Exporting chapter', { id, format });
        return await this.client.exportChapter(id, format);
      },
    };
  }
}