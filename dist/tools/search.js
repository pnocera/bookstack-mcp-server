"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchTools = void 0;
/**
 * Search tools for BookStack MCP Server
 *
 * Provides comprehensive search functionality across all content types
 */
class SearchTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all search tools
     */
    getTools() {
        return [
            this.createSearchTool(),
        ];
    }
    /**
     * Search tool
     */
    createSearchTool() {
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
            handler: async (params) => {
                this.logger.info('Searching content', { query: params.query, page: params.page, count: params.count });
                const validatedParams = this.validator.validateParams(params, 'search');
                return await this.client.search(validatedParams);
            },
        };
    }
}
exports.SearchTools = SearchTools;
exports.default = SearchTools;
//# sourceMappingURL=search.js.map