import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/**
 * Search tools for BookStack MCP Server
 * 
 * Provides comprehensive search functionality across all content types
 */
export class SearchTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all search tools
   */
  getTools(): MCPTool[] {
    return [
      this.createSearchTool(),
    ];
  }

  /**
   * Search tool
   */
  private createSearchTool(): MCPTool {
    return {
      name: 'bookstack_search',
      description: 'Search across all content types in BookStack using advanced search syntax',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            description: 'Search query using BookStack search syntax. Supports: exact phrases with quotes, field-specific searches (name:, description:, etc.), entity type filters ([book], [page], [chapter], [shelf]), tag searches (tag:value), and boolean operators',
          },
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Page number for pagination',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: 'Number of results per page',
          },
        },
      },
      handler: async (params: any) => {
        this.logger.info('Searching content', { query: params.query, page: params.page, count: params.count });
        const validatedParams = this.validator.validateParams<any>(params, 'search');
        return await this.client.search(validatedParams);
      },
    };
  }
}

export default SearchTools;