"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionTools = void 0;
/**
 * Permission management tools for BookStack MCP Server
 *
 * Provides 2 tools for content permission management:
 * - Read and update content permissions
 */
class PermissionTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all permission tools
     */
    getTools() {
        return [
            this.createReadPermissionsTool(),
            this.createUpdatePermissionsTool(),
        ];
    }
    /**
     * Read permissions tool
     */
    createReadPermissionsTool() {
        return {
            name: 'bookstack_permissions_read',
            description: 'Check who can see or edit a specific item. Returns the permission settings for a book, chapter, page, or shelf.',
            category: 'permissions',
            inputSchema: {
                type: 'object',
                required: ['content_type', 'content_id'],
                properties: {
                    content_type: {
                        type: 'string',
                        enum: ['book', 'chapter', 'page', 'bookshelf'],
                        description: 'The type of entity.',
                    },
                    content_id: {
                        type: 'integer',
                        description: 'The ID of the entity.',
                    },
                },
            },
            examples: [
                {
                    description: 'Check book permissions',
                    input: { content_type: 'book', content_id: 5 },
                    expected_output: 'Permission object',
                    use_case: 'Verifying access control',
                }
            ],
            usage_patterns: [
                'Use to debug why a user cannot see a page',
            ],
            related_tools: ['bookstack_permissions_update'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Item not found',
                    recovery_suggestion: 'Check ID',
                }
            ],
            handler: async (params) => {
                const { content_type, content_id } = params;
                const id = this.validator.validateId(content_id);
                this.logger.debug('Reading permissions', { content_type, content_id: id });
                return await this.client.getContentPermissions(content_type, id);
            },
        };
    }
    /**
     * Update permissions tool
     */
    createUpdatePermissionsTool() {
        return {
            name: 'bookstack_permissions_update',
            description: 'Set custom permissions for a specific item. Overrides default role-based access.',
            inputSchema: {
                type: 'object',
                required: ['content_type', 'content_id'],
                properties: {
                    content_type: {
                        type: 'string',
                        enum: ['book', 'chapter', 'page', 'bookshelf'],
                        description: 'Type of entity.',
                    },
                    content_id: {
                        type: 'integer',
                        description: 'ID of the entity.',
                    },
                    fallback_permissions: {
                        type: 'object',
                        properties: {
                            inheriting: {
                                type: 'boolean',
                                description: 'If true, inherits permissions from parent (default).',
                            },
                            restricted: {
                                type: 'boolean',
                                description: 'If true, restricts access to only specified roles/users.',
                            },
                        },
                        description: 'General settings.',
                    },
                    permissions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                role_id: {
                                    type: 'integer',
                                    description: 'Role to grant access to.',
                                },
                                user_id: {
                                    type: 'integer',
                                    description: 'User to grant access to.',
                                },
                                view: { type: 'boolean' },
                                create: { type: 'boolean' },
                                update: { type: 'boolean' },
                                delete: { type: 'boolean' },
                            },
                        },
                        description: 'Specific access grants.',
                    },
                },
            },
            examples: [
                {
                    description: 'Restrict book to specific role',
                    input: {
                        content_type: 'book',
                        content_id: 5,
                        fallback_permissions: { restricted: true },
                        permissions: [{ role_id: 3, view: true }]
                    },
                    expected_output: 'Updated permissions',
                    use_case: 'Locking down sensitive content',
                }
            ],
            usage_patterns: [
                'To restrict access, set `restricted: true` in fallback_permissions and add specific grants in `permissions`',
            ],
            related_tools: ['bookstack_permissions_read'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Item not found',
                    recovery_suggestion: 'Check ID',
                }
            ],
            handler: async (params) => {
                const { content_type, content_id, ...updateParams } = params;
                const id = this.validator.validateId(content_id);
                this.logger.info('Updating permissions', { content_type, content_id: id });
                const validatedParams = this.validator.validateParams(updateParams, 'contentPermissionsUpdate');
                return await this.client.updateContentPermissions(content_type, id, validatedParams);
            },
        };
    }
}
exports.PermissionTools = PermissionTools;
//# sourceMappingURL=permissions.js.map