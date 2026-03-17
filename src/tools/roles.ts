import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/**
 * Role management tools for BookStack MCP Server
 * 
 * Provides 5 tools for complete role lifecycle management:
 * - List, create, read, update, and delete roles
 */
export class RoleTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all role tools
   */
  getTools(): MCPTool[] {
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
  private createListRolesTool(): MCPTool {
    return {
      name: 'bookstack_roles_list',
      description: 'List all user roles. Roles define what actions users can perform (e.g., "Editor", "Admin").',
      category: 'roles',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of roles to return.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Pagination offset.',
          },
          sort: {
            type: 'string',
            enum: ['display_name', 'system_name', 'created_at', 'updated_at'],
            default: 'display_name',
            description: 'Sort field.',
          },
          filter: {
            type: 'object',
            properties: {
              display_name: {
                type: 'string',
                description: 'Filter by name.',
              },
              system_name: {
                type: 'string',
                description: 'Filter by system identifier.',
              },
            },
            description: 'Filters.',
          },
        },
      },
      examples: [
        {
          description: 'List roles',
          input: {},
          expected_output: 'List of roles',
          use_case: 'Checking available roles',
        }
      ],
      usage_patterns: [
        'Use to find role IDs for assigning to users',
      ],
      related_tools: ['bookstack_users_create'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Insufficient permissions',
          recovery_suggestion: 'Requires admin privileges',
        }
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing roles', params);
        const validatedParams = this.validator.validateParams<any>(params, 'rolesList');
        return await this.client.listRoles(validatedParams);
      },
    };
  }

  /**
   * Create role tool
   */
  private createCreateRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_create',
      description: 'Create a new user role with specific permissions.',
      inputSchema: {
        type: 'object',
        required: ['display_name'],
        properties: {
          display_name: {
            type: 'string',
            maxLength: 180,
            description: 'Name of the role.',
          },
          description: {
            type: 'string',
            maxLength: 1000,
            description: 'Short description.',
          },
          mfa_enforced: {
            type: 'boolean',
            default: false,
            description: 'Require MFA for users in this role.',
          },
          external_auth_id: {
            type: 'string',
            description: 'External ID for LDAP/SSO syncing.',
          },
          permissions: {
            type: 'object',
            properties: {
              'content-export': { type: 'boolean' },
              'settings-manage': { type: 'boolean' },
              'users-manage': { type: 'boolean' },
              'user-roles-manage': { type: 'boolean' },
              'restrictions-manage-all': { type: 'boolean' },
              'restrictions-manage-own': { type: 'boolean' },
            },
            description: 'System-level permissions.',
          },
        },
      },
      examples: [
        {
          description: 'Create an editor role',
          input: { display_name: 'Junior Editor', permissions: { 'content-export': true } },
          expected_output: 'Role object',
          use_case: 'Defining new access levels',
        }
      ],
      usage_patterns: [
        'Define clear roles to manage user access effectively',
      ],
      related_tools: ['bookstack_roles_list'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Invalid name',
          recovery_suggestion: 'Provide display_name',
        }
      ],
      handler: async (params: any) => {
        this.logger.info('Creating role', { display_name: params.display_name });
        const validatedParams = this.validator.validateParams<any>(params, 'roleCreate');
        return await this.client.createRole(validatedParams);
      },
    };
  }

  /**
   * Read role tool
   */
  private createReadRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_read',
      description: 'Get details of a specific role, including its system permissions.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the role.',
          },
        },
      },
      examples: [
        {
          description: 'Read role details',
          input: { id: 3 },
          expected_output: 'Role object with permissions',
          use_case: 'Checking what a role can do',
        }
      ],
      usage_patterns: [
        'Use to audit role capabilities',
      ],
      related_tools: ['bookstack_roles_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Role not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.debug('Reading role', { id });
        return await this.client.getRole(id);
      },
    };
  }

  /**
   * Update role tool
   */
  private createUpdateRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_update',
      description: 'Update a role\'s name, description, or permissions.',
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
            description: 'New display name',
          },
          description: {
            type: 'string',
            maxLength: 1000,
            description: 'New description',
          },
          mfa_enforced: {
            type: 'boolean',
            description: 'Enforce MFA',
          },
          external_auth_id: {
            type: 'string',
            description: 'External ID',
          },
          permissions: {
            type: 'object',
            properties: {
              'content-export': { type: 'boolean' },
              'settings-manage': { type: 'boolean' },
              'users-manage': { type: 'boolean' },
              'user-roles-manage': { type: 'boolean' },
              'restrictions-manage-all': { type: 'boolean' },
              'restrictions-manage-own': { type: 'boolean' },
            },
            description: 'New permissions (merges/updates existing)',
          },
        },
      },
      examples: [
        {
          description: 'Grant export permission',
          input: { id: 3, permissions: { 'content-export': true } },
          expected_output: 'Updated role',
          use_case: 'Elevating privileges',
        }
      ],
      usage_patterns: [
        'Read role first to see current permissions',
      ],
      related_tools: ['bookstack_roles_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Role not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating role', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'roleUpdate');
        return await this.client.updateRole(id, validatedParams);
      },
    };
  }

  /**
   * Delete role tool
   */
  private createDeleteRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_delete',
      description: 'Delete a role. You can optionally migrate users from this role to another one.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the role to delete',
          },
          migrate_ownership_id: {
            type: 'integer',
            description: 'ID of another role to move assigned users to.',
          },
        },
      },
      examples: [
        {
          description: 'Delete role and migrate users',
          input: { id: 3, migrate_ownership_id: 2 },
          expected_output: 'Success message',
          use_case: 'Consolidating roles',
        }
      ],
      usage_patterns: [
        'Always consider where existing users will go when deleting a role',
      ],
      related_tools: ['bookstack_roles_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Role not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.warn('Deleting role', { id, migrate_to: params.migrate_ownership_id });
        await this.client.deleteRole(id, params.migrate_ownership_id);
        return { success: true, message: `Role ${id} deleted successfully` };
      },
    };
  }
}