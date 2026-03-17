"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShelfTools = void 0;
/**
 * Bookshelf management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete bookshelf lifecycle management:
 * - List, create, read, update, and delete bookshelves
 */
class ShelfTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all shelf tools
     */
    getTools() {
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
    createListShelvesTool() {
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
            handler: async (params) => {
                this.logger.debug('Listing shelves', params);
                const validatedParams = this.validator.validateParams(params, 'shelvesList');
                return await this.client.listShelves(validatedParams);
            },
        };
    }
    /**
     * Create shelf tool
     */
    createCreateShelfTool() {
        return {
            name: 'bookstack_shelves_create',
            description: 'Create a new bookshelf. Bookshelves are used to group related books together for better organization.',
            inputSchema: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                        maxLength: 255,
                        description: 'Name of the shelf.',
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
                        },
                        description: 'List of book IDs to include in this shelf.',
                    },
                },
            },
            examples: [
                {
                    description: 'Create a shelf for Project X',
                    input: { name: 'Project X Documentation', books: [1, 2, 5] },
                    expected_output: 'Shelf object with assigned books',
                    use_case: 'Grouping project-specific books',
                }
            ],
            usage_patterns: [
                'Use shelves when you have multiple books that relate to a larger theme',
            ],
            related_tools: ['bookstack_books_create'],
            error_codes: [
                {
                    code: 'VALIDATION_ERROR',
                    description: 'Name is missing',
                    recovery_suggestion: 'Provide a name',
                }
            ],
            handler: async (params) => {
                this.logger.info('Creating shelf', { name: params.name });
                const validatedParams = this.validator.validateParams(params, 'shelfCreate');
                return await this.client.createShelf(validatedParams);
            },
        };
    }
    /**
     * Read shelf tool
     */
    createReadShelfTool() {
        return {
            name: 'bookstack_shelves_read',
            description: 'Get details of a specific bookshelf, including the list of books assigned to it.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
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
                }
            ],
            usage_patterns: [
                'Use to find books related to a specific topic/shelf',
            ],
            related_tools: ['bookstack_books_read'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Shelf not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading shelf', { id });
                return await this.client.getShelf(id);
            },
        };
    }
    /**
     * Update shelf tool
     */
    createUpdateShelfTool() {
        return {
            name: 'bookstack_shelves_update',
            description: 'Update a bookshelf\'s details. Can be used to rename, change description, or update the list of books on the shelf.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the shelf to update',
                    },
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 255,
                        description: 'New name',
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
                        },
                        description: 'New list of book IDs (replaces ALL existing books on this shelf).',
                    },
                },
            },
            examples: [
                {
                    description: 'Update books on a shelf',
                    input: { id: 3, books: [1, 5, 8] },
                    expected_output: 'Updated shelf object',
                    use_case: 'Reorganizing collections',
                }
            ],
            usage_patterns: [
                'To add a book to a shelf, you must read the shelf first to get the current list of books, add the new ID, and then call update with the full list.',
            ],
            related_tools: ['bookstack_shelves_read'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Shelf not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating shelf', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'shelfUpdate');
                return await this.client.updateShelf(id, validatedParams);
            },
        };
    }
    /**
     * Delete shelf tool
     */
    createDeleteShelfTool() {
        return {
            name: 'bookstack_shelves_delete',
            description: 'Delete a bookshelf. This action ONLY deletes the shelf container; it does NOT delete the books that were on the shelf.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
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
                }
            ],
            usage_patterns: [
                'Safe to use without losing content (books remain safe)',
            ],
            related_tools: ['bookstack_books_delete'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Shelf not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.warn('Deleting shelf', { id });
                await this.client.deleteShelf(id);
                return { success: true, message: `Shelf ${id} deleted successfully` };
            },
        };
    }
}
exports.ShelfTools = ShelfTools;
//# sourceMappingURL=shelves.js.map