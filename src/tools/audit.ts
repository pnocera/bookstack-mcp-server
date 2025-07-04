import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/**
 * Audit log tools for BookStack MCP Server
 * 
 * Provides 1 tool for audit log management:
 * - List audit log entries
 */
export class AuditTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all audit tools
   */
  getTools(): MCPTool[] {
    return [
      this.createListAuditLogTool(),
    ];
  }

  /**
   * List audit log tool
   */
  private createListAuditLogTool(): MCPTool {
    return {
      name: 'bookstack_audit_log_list',
      description: 'List audit log entries to track system activities and user actions',
      category: 'audit',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of audit log entries to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of audit log entries to skip',
          },
          sort: {
            type: 'string',
            enum: ['created_at'],
            default: 'created_at',
            description: 'Sort field (most recent first)',
          },
          filter: {
            type: 'object',
            properties: {
              event: {
                type: 'string',
                description: 'Filter by event type (e.g., page_create, user_login)',
              },
              user_id: {
                type: 'integer',
                description: 'Filter by user ID who performed the action',
              },
              entity_type: {
                type: 'string',
                enum: ['page', 'book', 'chapter', 'bookshelf', 'user', 'role'],
                description: 'Filter by entity type affected',
              },
              entity_id: {
                type: 'integer',
                description: 'Filter by specific entity ID affected',
              },
              date_from: {
                type: 'string',
                format: 'date',
                description: 'Filter events from this date (YYYY-MM-DD)',
              },
              date_to: {
                type: 'string',
                format: 'date',
                description: 'Filter events to this date (YYYY-MM-DD)',
              },
            },
            description: 'Optional filters to apply',
          },
        },
      },
      examples: [
        {
          description: 'List recent audit events',
          input: { count: 20 },
          expected_output: 'Array of audit log entries with details',
          use_case: 'Monitoring recent system activity',
        },
        {
          description: 'Find page creation events',
          input: { filter: { event: 'page_create' } },
          expected_output: 'Audit entries for page creation events',
          use_case: 'Tracking content creation activity',
        },
        {
          description: 'Find actions by specific user',
          input: { filter: { user_id: 5 } },
          expected_output: 'All audit entries for user ID 5',
          use_case: 'Investigating specific user activity',
        },
      ],
      usage_patterns: [
        'Monitor system activity and user actions',
        'Investigate security incidents',
        'Track content changes and deletions',
        'Compliance and audit requirements',
      ],
      related_tools: ['bookstack_users_list', 'bookstack_books_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and admin permissions',
        },
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing audit log entries', params);
        const validatedParams = this.validator.validateParams<any>(params, 'auditLogList');
        return await this.client.listAuditLog(validatedParams);
      },
    };
  }
}