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
      description: 'List all users. Users are people who can log in to BookStack.',
      category: 'users',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of users to return.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Pagination offset.',
          },
          sort: {
            type: 'string',
            enum: ['name', 'email', 'created_at', 'updated_at'],
            default: 'name',
            description: 'Sort field.',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by name.',
              },
              email: {
                type: 'string',
                description: 'Filter by email.',
              },
              active: {
                type: 'boolean',
                description: 'Filter by active status.',
              },
            },
            description: 'Filters.',
          },
        },
      },
      examples: [
        {
          description: 'Find user by email',
          input: { filter: { email: 'alice@example.com' } },
          expected_output: 'User object',
          use_case: 'Looking up a specific person',
        }
      ],
      usage_patterns: [
        'Use to check if a user exists',
      ],
      related_tools: ['bookstack_users_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Insufficient permissions',
          recovery_suggestion: 'Requires admin privileges',
        }
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
      description: 'Create a new user account. Requires name and email. Can optionally set a password and assign roles.',
      inputSchema: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
            description: 'Display name.',
          },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 255,
            description: 'Email address (must be unique).',
          },
          password: {
            type: 'string',
            minLength: 8,
            description: 'Initial password (if not provided, user may need to reset it or use external auth).',
          },
          roles: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'List of role IDs to assign.',
          },
          send_invite: {
            type: 'boolean',
            default: false,
            description: 'Send an email invitation.',
          },
          external_auth_id: {
            type: 'string',
            description: 'External ID for SSO.',
          },
        },
      },
      examples: [
        {
          description: 'Create a standard user',
          input: { name: 'John Doe', email: 'john@example.com', password: 'securePassword123', roles: [2] },
          expected_output: 'User object',
          use_case: 'Onboarding new team members',
        }
      ],
      usage_patterns: [
        'Assign default roles if unsure',
      ],
      related_tools: ['bookstack_roles_list'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Email already exists',
          recovery_suggestion: 'Use a different email',
        }
      ],
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
      description: 'Get details of a specific user, including their assigned roles.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the user.',
          },
        },
      },
      examples: [
        {
          description: 'Get user profile',
          input: { id: 5 },
          expected_output: 'User object with roles',
          use_case: 'Checking user status',
        }
      ],
      usage_patterns: [
        'Use to check current roles before updating',
      ],
      related_tools: ['bookstack_users_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'User not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
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
      description: 'Update a user\'s profile or roles.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the user to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New display name',
          },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 255,
            description: 'New email',
          },
          password: {
            type: 'string',
            minLength: 8,
            description: 'New password',
          },
          roles: {
            type: 'array',
            items: {
              type: 'integer',
            },
            description: 'New list of role IDs (replaces existing roles).',
          },
          active: {
            type: 'boolean',
            description: 'Active status (true/false).',
          },
          external_auth_id: {
            type: 'string',
            description: 'External ID.',
          },
        },
      },
      examples: [
        {
          description: 'Deactivate a user',
          input: { id: 5, active: false },
          expected_output: 'Updated user object',
          use_case: 'Offboarding',
        }
      ],
      usage_patterns: [
        'To append a role, read the user first to get current roles, add the new one, and then update.',
      ],
      related_tools: ['bookstack_users_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'User not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
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
      description: 'Delete a user account. You can optionally transfer their content (books, pages, etc.) to another user.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the user to delete',
          },
          migrate_ownership_id: {
            type: 'integer',
            description: 'ID of the user who will inherit the deleted user\'s content.',
          },
        },
      },
      examples: [
        {
          description: 'Delete user and transfer content',
          input: { id: 5, migrate_ownership_id: 1 },
          expected_output: 'Success message',
          use_case: 'Removing former employee but keeping their work',
        }
      ],
      usage_patterns: [
        'Always migrate ownership if the user has created content you want to keep',
      ],
      related_tools: ['bookstack_users_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'User not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.warn('Deleting user', { id, migrate_to: params.migrate_ownership_id });
        await this.client.deleteUser(id, params.migrate_ownership_id);
        return { success: true, message: `User ${id} deleted successfully` };
      },
    };
  }
}