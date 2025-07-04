"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoleTools = void 0;
/**
 * Role management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete role lifecycle management:
 * - List, create, read, update, and delete roles
 */
class RoleTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all role tools
     */
    getTools() {
        return [
            this.createListRolesTool(),
            this.createCreateRoleTool(),
            this.createReadRoleTool(),
            this.createUpdateRoleTool(),
            this.createDeleteRoleTool(),
        ];
    }
    /**
     * List roles tool
     */
    createListRolesTool() {
        return {
            name: 'bookstack_roles_list',
            description: 'List all roles in the system with pagination and filtering options',
            category: 'roles',
            inputSchema: {
                type: 'object',
                properties: {
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 500,
                        default: 20,
                        description: 'Number of roles to return',
                    },
                    offset: {
                        type: 'integer',
                        minimum: 0,
                        default: 0,
                        description: 'Number of roles to skip',
                    },
                    sort: {
                        type: 'string',
                        enum: ['display_name', 'system_name', 'created_at', 'updated_at'],
                        default: 'display_name',
                        description: 'Sort field',
                    },
                    filter: {
                        type: 'object',
                        properties: {
                            display_name: {
                                type: 'string',
                                description: 'Filter by role display name (partial match)',
                            },
                            system_name: {
                                type: 'string',
                                description: 'Filter by role system name (partial match)',
                            },
                        },
                        description: 'Optional filters to apply',
                    },
                },
            },
            examples: [
                {
                    description: 'List all roles',
                    input: {},
                    expected_output: 'Array of role objects with permissions',
                    use_case: 'Understanding available permission levels',
                },
                {
                    description: 'Find admin roles',
                    input: { filter: { display_name: 'admin' } },
                    expected_output: 'Roles containing "admin" in their name',
                    use_case: 'Finding administrative roles',
                },
            ],
            usage_patterns: [
                'Use before assigning roles to users',
                'Check available permission levels',
                'Find specific roles by name',
            ],
            related_tools: ['bookstack_roles_read', 'bookstack_users_update'],
            error_codes: [
                {
                    code: 'UNAUTHORIZED',
                    description: 'Authentication failed or insufficient permissions',
                    recovery_suggestion: 'Verify API token and admin permissions',
                },
            ],
            handler: async (params) => {
                this.logger.debug('Listing roles', params);
                const validatedParams = this.validator.validateParams(params, 'rolesList');
                return await this.client.listRoles(validatedParams);
            },
        };
    }
    /**
     * Create role tool
     */
    createCreateRoleTool() {
        return {
            name: 'bookstack_roles_create',
            description: 'Create a new role with display name, description, and permission settings',
            inputSchema: {
                type: 'object',
                required: ['display_name'],
                properties: {
                    display_name: {
                        type: 'string',
                        maxLength: 180,
                        description: 'Role display name (required)',
                    },
                    description: {
                        type: 'string',
                        maxLength: 1000,
                        description: 'Role description',
                    },
                    mfa_enforced: {
                        type: 'boolean',
                        default: false,
                        description: 'Enforce multi-factor authentication for this role',
                    },
                    external_auth_id: {
                        type: 'string',
                        description: 'External authentication ID for LDAP/SAML roles',
                    },
                    permissions: {
                        type: 'object',
                        properties: {
                            'content-export': {
                                type: 'boolean',
                                description: 'Allow content export',
                            },
                            'settings-manage': {
                                type: 'boolean',
                                description: 'Allow settings management',
                            },
                            'users-manage': {
                                type: 'boolean',
                                description: 'Allow user management',
                            },
                            'user-roles-manage': {
                                type: 'boolean',
                                description: 'Allow role management',
                            },
                            'restrictions-manage-all': {
                                type: 'boolean',
                                description: 'Allow managing all restrictions',
                            },
                            'restrictions-manage-own': {
                                type: 'boolean',
                                description: 'Allow managing own restrictions',
                            },
                        },
                        description: 'Permission settings for the role',
                    },
                },
            },
            handler: async (params) => {
                this.logger.info('Creating role', { display_name: params.display_name });
                const validatedParams = this.validator.validateParams(params, 'roleCreate');
                return await this.client.createRole(validatedParams);
            },
        };
    }
    /**
     * Read role tool
     */
    createReadRoleTool() {
        return {
            name: 'bookstack_roles_read',
            description: 'Get details of a specific role including all its permissions and settings',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Role ID to retrieve',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading role', { id });
                return await this.client.getRole(id);
            },
        };
    }
    /**
     * Update role tool
     */
    createUpdateRoleTool() {
        return {
            name: 'bookstack_roles_update',
            description: 'Update a role\'s details including name, description, and permission settings',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Role ID to update',
                    },
                    display_name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 180,
                        description: 'New role display name',
                    },
                    description: {
                        type: 'string',
                        maxLength: 1000,
                        description: 'New role description',
                    },
                    mfa_enforced: {
                        type: 'boolean',
                        description: 'New MFA enforcement setting',
                    },
                    external_auth_id: {
                        type: 'string',
                        description: 'New external authentication ID',
                    },
                    permissions: {
                        type: 'object',
                        properties: {
                            'content-export': {
                                type: 'boolean',
                                description: 'Allow content export',
                            },
                            'settings-manage': {
                                type: 'boolean',
                                description: 'Allow settings management',
                            },
                            'users-manage': {
                                type: 'boolean',
                                description: 'Allow user management',
                            },
                            'user-roles-manage': {
                                type: 'boolean',
                                description: 'Allow role management',
                            },
                            'restrictions-manage-all': {
                                type: 'boolean',
                                description: 'Allow managing all restrictions',
                            },
                            'restrictions-manage-own': {
                                type: 'boolean',
                                description: 'Allow managing own restrictions',
                            },
                        },
                        description: 'New permission settings for the role',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating role', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'roleUpdate');
                return await this.client.updateRole(id, validatedParams);
            },
        };
    }
    /**
     * Delete role tool
     */
    createDeleteRoleTool() {
        return {
            name: 'bookstack_roles_delete',
            description: 'Delete a role with option to migrate users to another role',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Role ID to delete',
                    },
                    migrate_ownership_id: {
                        type: 'integer',
                        description: 'Role ID to migrate users to (optional)',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.warn('Deleting role', { id, migrate_to: params.migrate_ownership_id });
                await this.client.deleteRole(id, params.migrate_ownership_id);
                return { success: true, message: `Role ${id} deleted successfully` };
            },
        };
    }
}
exports.RoleTools = RoleTools;
//# sourceMappingURL=roles.js.map