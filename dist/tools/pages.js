"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PageTools = void 0;
/**
 * Page management tools for BookStack MCP Server
 *
 * Provides 6 tools for complete page lifecycle management:
 * - List, create, read, update, delete, and export pages
 */
class PageTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all page tools
     */
    getTools() {
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
    createListPagesTools() {
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
            handler: async (params) => {
                this.logger.debug('Listing pages', params);
                const validatedParams = this.validator.validateParams(params, 'pagesList');
                return await this.client.listPages(validatedParams);
            },
        };
    }
    /**
     * Create page tool
     */
    createCreatePageTool() {
        return {
            name: 'bookstack_pages_create',
            description: 'Create a new page with content in HTML or Markdown format',
            inputSchema: {
                type: 'object',
                required: ['name'],
                properties: {
                    book_id: {
                        type: 'integer',
                        description: 'Parent book ID (required if chapter_id not provided)',
                    },
                    chapter_id: {
                        type: 'integer',
                        description: 'Parent chapter ID (required if book_id not provided)',
                    },
                    name: {
                        type: 'string',
                        maxLength: 255,
                        description: 'Page name (required)',
                    },
                    html: {
                        type: 'string',
                        description: 'Page content as HTML (required if markdown not provided)',
                    },
                    markdown: {
                        type: 'string',
                        description: 'Page content as Markdown (required if html not provided)',
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
                        description: 'Array of tags to assign to the page',
                    },
                    priority: {
                        type: 'integer',
                        description: 'Page priority for ordering within parent',
                    },
                },
            },
            handler: async (params) => {
                this.logger.info('Creating page', { name: params.name, book_id: params.book_id, chapter_id: params.chapter_id });
                const validatedParams = this.validator.validateParams(params, 'pageCreate');
                return await this.client.createPage(validatedParams);
            },
        };
    }
    /**
     * Read page tool
     */
    createReadPageTool() {
        return {
            name: 'bookstack_pages_read',
            description: 'Get details of a specific page including its full content in HTML and Markdown formats',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Page ID to retrieve',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading page', { id });
                return await this.client.getPage(id);
            },
        };
    }
    /**
     * Update page tool
     */
    createUpdatePageTool() {
        return {
            name: 'bookstack_pages_update',
            description: 'Update a page\'s details and content, including moving between books/chapters',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Page ID to update',
                    },
                    book_id: {
                        type: 'integer',
                        description: 'Move page to different book',
                    },
                    chapter_id: {
                        type: 'integer',
                        description: 'Move page to different chapter (null to move to book root)',
                    },
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 255,
                        description: 'New page name',
                    },
                    html: {
                        type: 'string',
                        description: 'New page content as HTML',
                    },
                    markdown: {
                        type: 'string',
                        description: 'New page content as Markdown',
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
                        description: 'New tags to assign to the page (replaces existing tags)',
                    },
                    priority: {
                        type: 'integer',
                        description: 'New page priority for ordering',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating page', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'pageUpdate');
                return await this.client.updatePage(id, validatedParams);
            },
        };
    }
    /**
     * Delete page tool
     */
    createDeletePageTool() {
        return {
            name: 'bookstack_pages_delete',
            description: 'Delete a page (moves to recycle bin where it can be restored)',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Page ID to delete',
                    },
                },
            },
            handler: async (params) => {
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
    createExportPageTool() {
        return {
            name: 'bookstack_pages_export',
            description: 'Export a page in various formats (HTML, PDF, plain text, or Markdown)',
            inputSchema: {
                type: 'object',
                required: ['id', 'format'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Page ID to export',
                    },
                    format: {
                        type: 'string',
                        enum: ['html', 'pdf', 'plaintext', 'markdown'],
                        description: 'Export format',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                const { format } = params;
                this.logger.info('Exporting page', { id, format });
                return await this.client.exportPage(id, format);
            },
        };
    }
}
exports.PageTools = PageTools;
exports.default = PageTools;
//# sourceMappingURL=pages.js.map