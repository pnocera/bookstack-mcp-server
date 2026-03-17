import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

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
    return [
      this.createListPagesTools(),
      this.createCreatePageTool(),
      this.createReadPageTool(),
      this.createUpdatePageTool(),
      this.createDeletePageTool(),
      this.createExportPageTool(),
    ];
  }

  /**
   * List pages tool
   */
  private createListPagesTools(): MCPTool {
    return {
      name: 'bookstack_pages_list',
      description: 'List all pages visible to the authenticated user with pagination and filtering options',
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
              chapter_id: {
                type: 'integer',
                description: 'Filter by chapter ID',
              },
              name: {
                type: 'string',
                description: 'Filter by page name (partial match)',
              },
              draft: {
                type: 'boolean',
                description: 'Filter by draft status',
              },
              template: {
                type: 'boolean',
                description: 'Filter by template status',
              },
            },
            description: 'Optional filters to apply',
          },
        },
      },
      handler: async (params: any) => {
        this.logger.debug('Listing pages', params);
        const validatedParams = this.validator.validateParams<any>(params, 'pagesList');
        return await this.client.listPages(validatedParams);
      },
    };
  }

  /**
   * Create page tool
   */
  private createCreatePageTool(): MCPTool {
    return {
      name: 'bookstack_pages_create',
      description: 'Create a new page. Pages are the leaf nodes where actual content lives. You must provide content in either HTML or Markdown format, and specify a parent book or chapter.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          book_id: {
            type: 'integer',
            description: 'ID of the parent book (Required if chapter_id is not provided).',
          },
          chapter_id: {
            type: 'integer',
            description: 'ID of the parent chapter (Required if book_id is not provided).',
          },
          name: {
            type: 'string',
            maxLength: 255,
            description: 'Title of the page.',
          },
          html: {
            type: 'string',
            description: 'Page content in HTML format. Use this OR markdown, not both.',
          },
          markdown: {
            type: 'string',
            description: 'Page content in Markdown format. Use this OR html, not both. Preferred for LLM generation.',
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
            description: 'Order priority relative to other pages in the same parent. Higher numbers are lower in the list? (Check BookStack docs usually implies sorting order)',
          },
        },
      },
      examples: [
        {
          description: 'Create a markdown page in a book',
          input: {
            book_id: 5,
            name: 'Installation Guide',
            markdown: '# Installation\n\nRun `npm install` to get started.'
          },
          expected_output: 'Created page object',
          use_case: 'Adding new documentation content',
        }
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
        }
      ],
      handler: async (params: any) => {
        this.logger.info('Creating page', { name: params.name, book_id: params.book_id, chapter_id: params.chapter_id });
        const validatedParams = this.validator.validateParams<any>(params, 'pageCreate');
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
      description: 'Get the full details and content of a page. This includes the raw HTML and Markdown content.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
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
        }
      ],
      usage_patterns: [
        'Use this to get the "before" state of content when performing updates',
        'Useful for answering questions based on specific documentation',
      ],
      related_tools: ['bookstack_books_read', 'bookstack_search_query'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Update a page\'s content or properties. Can be used to rename, rewrite content, or move the page to a different book/chapter.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the page to update',
          },
          book_id: {
            type: 'integer',
            description: 'New parent book ID. Use to move the page.',
          },
          chapter_id: {
            type: 'integer',
            description: 'New parent chapter ID. Use to move the page (Set to 0/null to move to book root).',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New page name',
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
            description: 'New priority order.',
          },
        },
      },
      examples: [
        {
          description: 'Append content to a page',
          input: {
            id: 12,
            markdown: '# Original Title\n\nOriginal content...\n\n## New Section\n\nAdded content.'
          },
          expected_output: 'Updated page object',
          use_case: 'Refining documentation',
        }
      ],
      usage_patterns: [
        'Always read the page first (`bookstack_pages_read`) to get current content if you intend to append or modify partially, as this tool replaces the content field entirely.',
      ],
      related_tools: ['bookstack_pages_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating page', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'pageUpdate');
        return await this.client.updatePage(id, validatedParams);
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
        }
      ],
      usage_patterns: [
        'Check recycle bin to restore if needed',
      ],
      related_tools: ['bookstack_recyclebin_restore'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Export a page to a specific format (HTML, PDF, Markdown, Plain Text).',
      inputSchema: {
        type: 'object',
        required: ['id', 'format'],
        properties: {
          id: {
            type: 'integer',
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
          expected_output: 'String content',
          use_case: 'Extracting content for processing',
        }
      ],
      usage_patterns: [
        'Use "plaintext" or "markdown" for processing text in LLMs',
      ],
      related_tools: ['bookstack_books_export'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        const { format } = params;
        this.logger.info('Exporting page', { id, format });
        return await this.client.exportPage(id, format);
      },
    };
  }
}

export default PageTools;