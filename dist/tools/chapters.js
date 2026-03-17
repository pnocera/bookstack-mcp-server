"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChapterTools = void 0;
/**
 * Chapter management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete chapter lifecycle management:
 * - List, create, read, update, delete, and export chapters
 */
class ChapterTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all chapter tools
     */
    getTools() {
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
    createListChaptersTool() {
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
            handler: async (params) => {
                this.logger.debug('Listing chapters', params);
                const validatedParams = this.validator.validateParams(params, 'chaptersList');
                return await this.client.listChapters(validatedParams);
            },
        };
    }
    /**
     * Create chapter tool
     */
    createCreateChapterTool() {
        return {
            name: 'bookstack_chapters_create',
            description: 'Create a new chapter within a book. Chapters are used to group related pages together.',
            inputSchema: {
                type: 'object',
                required: ['book_id', 'name'],
                properties: {
                    book_id: {
                        type: 'integer',
                        description: 'ID of the book that will contain this chapter.',
                    },
                    name: {
                        type: 'string',
                        maxLength: 255,
                        description: 'Name of the chapter.',
                    },
                    description: {
                        type: 'string',
                        maxLength: 1900,
                        description: 'Short description of the chapter contents.',
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
                    priority: {
                        type: 'integer',
                        description: 'Order priority.',
                    },
                },
            },
            examples: [
                {
                    description: 'Create a chapter',
                    input: { book_id: 5, name: 'Advanced Configuration' },
                    expected_output: 'Chapter object',
                    use_case: 'Structuring a book',
                }
            ],
            usage_patterns: [
                'Organize pages into chapters when a book becomes too large or flat',
            ],
            related_tools: ['bookstack_books_read', 'bookstack_pages_create'],
            error_codes: [
                {
                    code: 'VALIDATION_ERROR',
                    description: 'Invalid book_id or missing name',
                    recovery_suggestion: 'Verify inputs',
                }
            ],
            handler: async (params) => {
                this.logger.info('Creating chapter', { name: params.name, book_id: params.book_id });
                const validatedParams = this.validator.validateParams(params, 'chapterCreate');
                return await this.client.createChapter(validatedParams);
            },
        };
    }
    /**
     * Read chapter tool
     */
    createReadChapterTool() {
        return {
            name: 'bookstack_chapters_read',
            description: 'Get details of a specific chapter, including a list of pages contained within it.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'The unique ID of the chapter.',
                    },
                },
            },
            examples: [
                {
                    description: 'Read chapter details',
                    input: { id: 8 },
                    expected_output: 'Chapter object with pages list',
                    use_case: 'Listing pages in a specific section',
                }
            ],
            usage_patterns: [
                'Use to find page IDs within a chapter',
            ],
            related_tools: ['bookstack_pages_read'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Chapter not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading chapter', { id });
                return await this.client.getChapter(id);
            },
        };
    }
    /**
     * Update chapter tool
     */
    createUpdateChapterTool() {
        return {
            name: 'bookstack_chapters_update',
            description: 'Update a chapter\'s details. Can be used to rename, change description, or move to a different book.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the chapter to update',
                    },
                    book_id: {
                        type: 'integer',
                        description: 'New parent book ID (Use to move the chapter)',
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
                    priority: {
                        type: 'integer',
                        description: 'New priority',
                    },
                },
            },
            examples: [
                {
                    description: 'Rename a chapter',
                    input: { id: 8, name: 'Renamed Chapter' },
                    expected_output: 'Updated chapter object',
                    use_case: 'Correcting titles',
                }
            ],
            usage_patterns: [
                'To append tags, read the chapter first to get existing tags',
            ],
            related_tools: ['bookstack_chapters_read'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Chapter not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating chapter', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'chapterUpdate');
                return await this.client.updateChapter(id, validatedParams);
            },
        };
    }
    /**
     * Delete chapter tool
     */
    createDeleteChapterTool() {
        return {
            name: 'bookstack_chapters_delete',
            description: 'Move a chapter and all its child pages to the recycle bin.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the chapter to delete',
                    },
                },
            },
            examples: [
                {
                    description: 'Delete a chapter',
                    input: { id: 8 },
                    expected_output: 'Success message',
                    use_case: 'Removing a whole section',
                }
            ],
            usage_patterns: [
                'WARNING: This also deletes all pages within the chapter. Use caution.',
            ],
            related_tools: ['bookstack_recyclebin_restore'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Chapter not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
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
    createExportChapterTool() {
        return {
            name: 'bookstack_chapters_export',
            description: 'Export a chapter to a specific format. Includes content from all pages in the chapter.',
            inputSchema: {
                type: 'object',
                required: ['id', 'format'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the chapter to export',
                    },
                    format: {
                        type: 'string',
                        enum: ['html', 'pdf', 'plaintext', 'markdown'],
                        description: 'Desired format',
                    },
                },
            },
            examples: [
                {
                    description: 'Export chapter as PDF',
                    input: { id: 8, format: 'pdf' },
                    expected_output: 'PDF file content',
                    use_case: 'Creating a printable section guide',
                }
            ],
            usage_patterns: [
                'Use "plaintext" or "markdown" for LLM context injection',
            ],
            related_tools: ['bookstack_books_export'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Chapter not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                const { format } = params;
                this.logger.info('Exporting chapter', { id, format });
                return await this.client.exportChapter(id, format);
            },
        };
    }
}
exports.ChapterTools = ChapterTools;
//# sourceMappingURL=chapters.js.map