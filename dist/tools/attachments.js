"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentTools = void 0;
/**
 * Attachment management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete attachment lifecycle management:
 * - List, create, read, update, and delete attachments
 */
class AttachmentTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all attachment tools
     */
    getTools() {
        return [
            this.createListAttachmentsTool(),
            this.createCreateAttachmentTool(),
            this.createReadAttachmentTool(),
            this.createUpdateAttachmentTool(),
            this.createDeleteAttachmentTool(),
        ];
    }
    /**
     * List attachments tool
     */
    createListAttachmentsTool() {
        return {
            name: 'bookstack_attachments_list',
            description: 'List all attachments visible to the authenticated user with pagination and filtering options',
            category: 'attachments',
            inputSchema: {
                type: 'object',
                properties: {
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 500,
                        default: 20,
                        description: 'Number of attachments to return',
                    },
                    offset: {
                        type: 'integer',
                        minimum: 0,
                        default: 0,
                        description: 'Number of attachments to skip',
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
                            uploaded_to: {
                                type: 'integer',
                                description: 'Filter by page ID the attachment belongs to',
                            },
                            name: {
                                type: 'string',
                                description: 'Filter by attachment name (partial match)',
                            },
                            extension: {
                                type: 'string',
                                description: 'Filter by file extension (e.g., pdf, doc, txt)',
                            },
                        },
                        description: 'Optional filters to apply',
                    },
                },
            },
            examples: [
                {
                    description: 'List first 10 attachments',
                    input: { count: 10 },
                    expected_output: 'Array of attachment objects with metadata',
                    use_case: 'Getting overview of available files',
                },
                {
                    description: 'Find PDF attachments',
                    input: { filter: { extension: 'pdf' } },
                    expected_output: 'Attachments with PDF extension',
                    use_case: 'Finding specific document types',
                },
            ],
            usage_patterns: [
                'Use before downloading specific attachments',
                'Filter by page to see page-specific files',
                'Search by extension to find file types',
            ],
            related_tools: ['bookstack_attachments_read', 'bookstack_pages_read'],
            error_codes: [
                {
                    code: 'UNAUTHORIZED',
                    description: 'Authentication failed or insufficient permissions',
                    recovery_suggestion: 'Verify API token and permissions',
                },
            ],
            handler: async (params) => {
                this.logger.debug('Listing attachments', params);
                const validatedParams = this.validator.validateParams(params, 'attachmentsList');
                return await this.client.listAttachments(validatedParams);
            },
        };
    }
    /**
     * Create attachment tool
     */
    createCreateAttachmentTool() {
        return {
            name: 'bookstack_attachments_create',
            description: 'Create a new attachment by uploading a file or linking to an external URL. Attachments are always associated with a specific page.',
            inputSchema: {
                type: 'object',
                required: ['uploaded_to', 'name'],
                properties: {
                    uploaded_to: {
                        type: 'integer',
                        description: 'ID of the page to attach the file to.',
                    },
                    name: {
                        type: 'string',
                        maxLength: 255,
                        description: 'Name/Title of the attachment.',
                    },
                    file: {
                        type: 'string',
                        description: 'Base64 encoded file content. (Required if link is not provided)',
                    },
                    link: {
                        type: 'string',
                        format: 'uri',
                        description: 'External URL. (Required if file is not provided)',
                    },
                },
            },
            examples: [
                {
                    description: 'Attach a PDF file',
                    input: { uploaded_to: 12, name: 'Manual.pdf', file: '<base64_content>' },
                    expected_output: 'Attachment object',
                    use_case: 'Adding supplementary files',
                },
                {
                    description: 'Attach a link',
                    input: { uploaded_to: 12, name: 'External Resource', link: 'https://example.com' },
                    expected_output: 'Attachment object',
                    use_case: 'Linking to external references',
                }
            ],
            usage_patterns: [
                'Use attachments for non-image files or external links that should be associated with a page',
            ],
            related_tools: ['bookstack_pages_read'],
            error_codes: [
                {
                    code: 'VALIDATION_ERROR',
                    description: 'Missing file/link or page ID',
                    recovery_suggestion: 'Provide either file OR link, and a valid uploaded_to ID',
                }
            ],
            handler: async (params) => {
                this.logger.info('Creating attachment', { name: params.name, uploaded_to: params.uploaded_to });
                const validatedParams = this.validator.validateParams(params, 'attachmentCreate');
                return await this.client.createAttachment(validatedParams);
            },
        };
    }
    /**
     * Read attachment tool
     */
    createReadAttachmentTool() {
        return {
            name: 'bookstack_attachments_read',
            description: 'Get details of a specific attachment, including its download URL.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'The unique ID of the attachment.',
                    },
                },
            },
            examples: [
                {
                    description: 'Get attachment info',
                    input: { id: 42 },
                    expected_output: 'Attachment object with links',
                    use_case: 'Retrieving download URL',
                }
            ],
            usage_patterns: [
                'Use to get the URL for downloading a file',
            ],
            related_tools: ['bookstack_attachments_list'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Attachment not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading attachment', { id });
                return await this.client.getAttachment(id);
            },
        };
    }
    /**
     * Update attachment tool
     */
    createUpdateAttachmentTool() {
        return {
            name: 'bookstack_attachments_update',
            description: 'Update an attachment\'s details. Can be used to rename, change the linked page, or replace the file content.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the attachment to update',
                    },
                    uploaded_to: {
                        type: 'integer',
                        description: 'New page ID to associate with (Move attachment)',
                    },
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 255,
                        description: 'New name',
                    },
                    file: {
                        type: 'string',
                        description: 'New Base64 encoded file content (Replaces existing file)',
                    },
                    link: {
                        type: 'string',
                        format: 'uri',
                        description: 'New external URL (Replaces existing link)',
                    },
                },
            },
            examples: [
                {
                    description: 'Rename attachment',
                    input: { id: 42, name: 'Updated Manual.pdf' },
                    expected_output: 'Updated attachment object',
                    use_case: 'Correcting filenames',
                }
            ],
            usage_patterns: [
                'Be careful when updating file content, it permanently replaces the old file',
            ],
            related_tools: ['bookstack_attachments_read'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Attachment not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating attachment', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'attachmentUpdate');
                return await this.client.updateAttachment(id, validatedParams);
            },
        };
    }
    /**
     * Delete attachment tool
     */
    createDeleteAttachmentTool() {
        return {
            name: 'bookstack_attachments_delete',
            description: 'Permanently delete an attachment. This action cannot be undone.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'ID of the attachment to delete',
                    },
                },
            },
            examples: [
                {
                    description: 'Delete an attachment',
                    input: { id: 42 },
                    expected_output: 'Success message',
                    use_case: 'Removing obsolete files',
                }
            ],
            usage_patterns: [
                'Confirm ID before deleting as this is permanent',
            ],
            related_tools: ['bookstack_attachments_list'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Attachment not found',
                    recovery_suggestion: 'Verify ID',
                }
            ],
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.warn('Deleting attachment', { id });
                await this.client.deleteAttachment(id);
                return { success: true, message: `Attachment ${id} deleted successfully` };
            },
        };
    }
}
exports.AttachmentTools = AttachmentTools;
//# sourceMappingURL=attachments.js.map