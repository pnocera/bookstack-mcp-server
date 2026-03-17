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
            description: 'Search across all BookStack content (Books, Chapters, Pages, Shelves). Supports advanced query syntax for filtering.',
            inputSchema: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: {
                        type: 'string',
                        minLength: 1,
                        description: 'Search query string. Supports advanced syntax: "exact phrase", {type:page|book|chapter|shelf}, {tag:name=value}, {created_by:me}.',
                    },
                    page: {
                        type: 'integer',
                        minimum: 1,
                        default: 1,
                        description: 'Page number for pagination.',
                    },
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 100,
                        default: 20,
                        description: 'Results per page.',
                    },
                },
            },
            examples: [
                {
                    description: 'Search for "API" in pages only',
                    input: { query: 'API {type:page}' },
                    expected_output: 'List of matching pages',
                    use_case: 'Finding specific documentation',
                },
                {
                    description: 'Search by tag',
                    input: { query: '{tag:status=active}' },
                    expected_output: 'Content with status:active tag',
                    use_case: 'Filtering by metadata',
                }
            ],
            usage_patterns: [
                'Use specific filters like `{type:book}` to narrow down results',
                'Use quotes for exact match searches: `"error code 500"`',
            ],
            related_tools: ['bookstack_pages_list', 'bookstack_books_list'],
            error_codes: [
                {
                    code: 'VALIDATION_ERROR',
                    description: 'Empty query',
                    recovery_suggestion: 'Provide a search term',
                }
            ],
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