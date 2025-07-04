import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/**
 * User management tools for BookStack MCP Server
 * 
 * Provides 5 tools for complete user lifecycle management:
 * - List, create, read, update, and delete users
 */
export class UserTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all user tools
   */
  getTools(): MCPTool[] {
    return [
      this.createListUsersTool(),
      this.createCreateUserTool(),
      this.createReadUserTool(),
      this.createUpdateUserTool(),
      this.createDeleteUserTool(),
    ];
  }

  /**
   * List users tool
   */
  private createListUsersTool(): MCPTool {
    return {
      name: 'bookstack_users_list',
      description: 'List all users in the system with pagination and filtering options',
      category: 'users',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of users to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of users to skip',
          },
          sort: {
            type: 'string',
            enum: ['name', 'email', 'created_at', 'updated_at'],
            default: 'name',
            description: 'Sort field',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by user name (partial match)',
              },
              email: {
                type: 'string',
                description: 'Filter by email address (partial match)',
              },
              active: {
                type: 'boolean',
                description: 'Filter by active status',
              },
            },
            description: 'Optional filters to apply',
          },
        },
      },
      examples: [
        {
          description: 'List first 10 users',
          input: { count: 10 },
          expected_output: 'Array of user objects with metadata',
          use_case: 'Getting overview of system users',
        },
        {
          description: 'Find active users only',
          input: { filter: { active: true } },
          expected_output: 'Only active users in the system',
          use_case: 'Finding users who can access the system',
        },
      ],
      usage_patterns: [
        'Use before managing user permissions',
        'Filter by active status to find enabled users',
        'Search by email to find specific users',
      ],
      related_tools: ['bookstack_users_read', 'bookstack_roles_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and admin permissions',
        },
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing users', params);
        const validatedParams = this.validator.validateParams<any>(params, 'usersList');
        return await this.client.listUsers(validatedParams);
      },
    };
  }

  /**
   * Create user tool
   */
  private createCreateUserTool(): MCPTool {
    return {
      name: 'bookstack_users_create',
      description: 'Create a new user account with email, name, and role assignments',
      inputSchema: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
            description: 'User display name (required)',
          },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 255,
            description: 'User email address (required, must be unique)',
          },
          password: {
            type: 'string',
            minLength: 8,
            description: 'User password (required for local accounts)',
          },
          roles: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'Array of role IDs to assign to the user',
          },
          send_invite: {
            type: 'boolean',
            default: false,
            description: 'Send invitation email to the user',
          },
          external_auth_id: {
            type: 'string',
            description: 'External authentication ID for LDAP/SAML users',
          },
        },
      },
      handler: async (params: any) => {
        this.logger.info('Creating user', { name: params.name, email: params.email });
        const validatedParams = this.validator.validateParams<any>(params, 'userCreate');
        return await this.client.createUser(validatedParams);
      },
    };
  }

  /**
   * Read user tool
   */
  private createReadUserTool(): MCPTool {
    return {
      name: 'bookstack_users_read',
      description: 'Get details of a specific user including their roles and permissions',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'User ID to retrieve',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.debug('Reading user', { id });
        return await this.client.getUser(id);
      },
    };
  }

  /**
   * Update user tool
   */
  private createUpdateUserTool(): MCPTool {
    return {
      name: 'bookstack_users_update',
      description: 'Update a user\'s details including name, email, password, and role assignments',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'User ID to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New user display name',
          },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 255,
            description: 'New user email address (must be unique)',
          },
          password: {
            type: 'string',
            minLength: 8,
            description: 'New user password',
          },
          roles: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'New array of role IDs (replaces existing roles)',
          },
          active: {
            type: 'boolean',
            description: 'Set user active/inactive status',
          },
          external_auth_id: {
            type: 'string',
            description: 'External authentication ID for LDAP/SAML users',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating user', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'userUpdate');
        return await this.client.updateUser(id, validatedParams);
      },
    };
  }

  /**
   * Delete user tool
   */
  private createDeleteUserTool(): MCPTool {
    return {
      name: 'bookstack_users_delete',
      description: 'Delete a user account with option to migrate content ownership to another user',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'User ID to delete',
          },
          migrate_ownership_id: {
            type: 'integer',
            description: 'User ID to transfer content ownership to (optional)',
          },
        },
      },
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.warn('Deleting user', { id, migrate_to: params.migrate_ownership_id });
        await this.client.deleteUser(id, params.migrate_ownership_id);
        return { success: true, message: `User ${id} deleted successfully` };
      },
    };
  }
}