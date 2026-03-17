"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookTools = void 0;
/**
 * Book management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete book lifecycle management:
 * - List, create, read, update, delete, and export books
 */
class BookTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all book tools
     */
    getTools() {
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
    createListBooksTools() {
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
            handler: async (params) => {
                this.logger.debug('Listing books', params);
                const validatedParams = this.validator.validateParams(params, 'booksList');
                return await this.client.listBooks(validatedParams);
            },
        };
    }
    /**
     * Create book tool
     */
    createCreateBookTool() {
        return {
            name: 'bookstack_books_create',
            description: 'Create a new book in BookStack. Books are the highest level of organization and contain chapters and pages. A book must exist before you can add content to it.',
            inputSchema: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: {
                        type: 'string',
                        maxLength: 255,
                        description: 'The name of the book. Must be unique within the instance.',
                    },
                    description: {
                        type: 'string',
                        maxLength: 1900,
                        description: 'A short description of the book\'s purpose or contents.',
                    },
                    description_html: {
                        type: 'string',
                        maxLength: 2000,
                        description: 'HTML formatted description. Overrides the plain text description if provided.',
                    },
                    tags: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: {
                                    type: 'string',
                                    description: 'Tag label (e.g., "Category")',
                                },
                                value: {
                                    type: 'string',
                                    description: 'Tag value (e.g., "API Docs")',
                                },
                            },
                            required: ['name', 'value'],
                        },
                        description: 'Key-value pairs for categorization and filtering.',
                    },
                    default_template_id: {
                        type: 'integer',
                        description: 'The ID of a page to use as the default template for new pages created in this book.',
                    },
                },
            },
            examples: [
                {
                    description: 'Create a basic developer documentation book',
                    input: {
                        name: 'Developer Guides',
                        description: 'Technical documentation for the engineering team.',
                        tags: [{ name: 'Department', value: 'Engineering' }]
                    },
                    expected_output: 'JSON object of the created book including its new ID',
                    use_case: 'Setting up a new knowledge base section',
                }
            ],
            usage_patterns: [
                'Create a book first to establish a container for chapters and pages',
                'Use tags to make the book easier to find in searches',
            ],
            related_tools: ['bookstack_books_list', 'bookstack_chapters_create', 'bookstack_pages_create'],
            error_codes: [
                {
                    code: 'VALIDATION_ERROR',
                    description: 'Name is missing or too long',
                    recovery_suggestion: 'Ensure name is provided and under 255 characters',
                }
            ],
            handler: async (params) => {
                this.logger.info('Creating book', { name: params.name });
                const validatedParams = this.validator.validateParams(params, 'bookCreate');
                return await this.client.createBook(validatedParams);
            },
        };
    }
    /**
     * Read book tool
     */
    createReadBookTool() {
        return {
            name: 'bookstack_books_read',
            description: 'Get details of a specific book including its complete content hierarchy (chapters and pages). Use this to explore what is inside a book.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
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
                }
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
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading book', { id });
                return await this.client.getBook(id);
            },
        };
    }
    /**
     * Update book tool
     */
    createUpdateBookTool() {
        return {
            name: 'bookstack_books_update',
            description: 'Update a book\'s details including name, description, tags, and template settings.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the book to update',
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
                        description: 'New tags to assign (replaces existing tags).',
                    },
                    default_template_id: {
                        type: 'integer',
                        description: 'New default page template ID',
                    },
                },
            },
            examples: [
                {
                    description: 'Rename a book',
                    input: { id: 5, name: 'Updated Developer Guides' },
                    expected_output: 'Updated book object',
                    use_case: 'Correcting a typo or renaming a project',
                }
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
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating book', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'bookUpdate');
                return await this.client.updateBook(id, validatedParams);
            },
        };
    }
    /**
     * Delete book tool
     */
    createDeleteBookTool() {
        return {
            name: 'bookstack_books_delete',
            description: 'Delete a book. This moves the book and all its contents (chapters, pages) to the recycle bin. It can be restored later using the recycle bin tools.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
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
                }
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
                }
            ],
            handler: async (params) => {
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
    createExportBookTool() {
        return {
            name: 'bookstack_books_export',
            description: 'Export a book to a specific format. Useful for backups, offline reading, or migrating content.',
            inputSchema: {
                type: 'object',
                required: ['id', 'format'],
                properties: {
                    id: {
                        type: 'integer',
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
                    expected_output: 'File content string',
                    use_case: 'Getting raw content for migration or git backup',
                }
            ],
            usage_patterns: [
                'Use "markdown" or "plaintext" for LLM context injection as they are more token-efficient than HTML or PDF',
            ],
            related_tools: ['bookstack_pages_export', 'bookstack_chapters_export'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Book not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                const { format } = params;
                this.logger.info('Exporting book', { id, format });
                return await this.client.exportBook(id, format);
            },
        };
    }
}
exports.BookTools = BookTools;
exports.default = BookTools;
//# sourceMappingURL=books.js.map