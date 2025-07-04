import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/**
 * Permission management tools for BookStack MCP Server
 * 
 * Provides 2 tools for content permission management:
 * - Read and update content permissions
 */
export class PermissionTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all permission tools
   */
  getTools(): MCPTool[] {
    return [
      this.createReadPermissionsTool(),
      this.createUpdatePermissionsTool(),
    ];
  }

  /**
   * Read permissions tool
   */
  private createReadPermissionsTool(): MCPTool {
    return {
      name: 'bookstack_permissions_read',
      description: 'Get permission settings for specific content (books, chapters, pages, or shelves)',
      category: 'permissions',
      inputSchema: {
        type: 'object',
        required: ['content_type', 'content_id'],
        properties: {
          content_type: {
            type: 'string',
            enum: ['book', 'chapter', 'page', 'bookshelf'],
            description: 'Type of content to check permissions for',
          },
          content_id: {
            type: 'integer',
            description: 'ID of the content item',
          },
        },
      },
      examples: [
        {
          description: 'Check book permissions',
          input: { content_type: 'book', content_id: 5 },
          expected_output: 'Permission settings for book ID 5',
          use_case: 'Understanding who can access a specific book',
        },
        {
          description: 'Check page permissions',
          input: { content_type: 'page', content_id: 123 },
          expected_output: 'Permission settings for page ID 123',
          use_case: 'Verifying access control for sensitive pages',
        },
      ],
      usage_patterns: [
        'Use before updating permissions to see current state',
        'Check permissions to understand access restrictions',
        'Audit content access settings',
      ],
      related_tools: ['bookstack_permissions_update', 'bookstack_users_list', 'bookstack_roles_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and admin permissions',
        },
        {
          code: 'NOT_FOUND',
          description: 'Content item not found',
          recovery_suggestion: 'Verify content_type and content_id are correct',
        },
      ],
      handler: async (params: any) => {
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
  private createUpdatePermissionsTool(): MCPTool {
    return {
      name: 'bookstack_permissions_update',
      description: 'Update permission settings for specific content to control user and role access',
      inputSchema: {
        type: 'object',
        required: ['content_type', 'content_id'],
        properties: {
          content_type: {
            type: 'string',
            enum: ['book', 'chapter', 'page', 'bookshelf'],
            description: 'Type of content to update permissions for',
          },
          content_id: {
            type: 'integer',
            description: 'ID of the content item',
          },
          fallback_permissions: {
            type: 'object',
            properties: {
              inheriting: {
                type: 'boolean',
                description: 'Whether to inherit permissions from parent',
              },
              restricted: {
                type: 'boolean',
                description: 'Whether content has custom restrictions',
              },
            },
            description: 'Fallback permission settings',
          },
          permissions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role_id: {
                  type: 'integer',
                  description: 'Role ID to grant permissions to',
                },
                user_id: {
                  type: 'integer',
                  description: 'User ID to grant permissions to (alternative to role_id)',
                },
                view: {
                  type: 'boolean',
                  description: 'Allow view access',
                },
                create: {
                  type: 'boolean',
                  description: 'Allow create access',
                },
                update: {
                  type: 'boolean',
                  description: 'Allow update access',
                },
                delete: {
                  type: 'boolean',
                  description: 'Allow delete access',
                },
              },
            },
            description: 'Array of specific permission grants',
          },
        },
      },
      handler: async (params: any) => {
        const { content_type, content_id, ...updateParams } = params;
        const id = this.validator.validateId(content_id);
        this.logger.info('Updating permissions', { content_type, content_id: id });
        const validatedParams = this.validator.validateParams<any>(updateParams, 'contentPermissionsUpdate');
        return await this.client.updateContentPermissions(content_type, id, validatedParams);
      },
    };
  }
}