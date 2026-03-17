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
      description: 'Retrieve the audit log to see recent activities on the instance.',
      category: 'audit',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of entries to return.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Pagination offset.',
          },
          sort: {
            type: 'string',
            enum: ['created_at'],
            default: 'created_at',
            description: 'Sort direction (default is recent first).',
          },
          filter: {
            type: 'object',
            properties: {
              event: {
                type: 'string',
                description: 'Filter by event key (e.g. "page_create", "user_login").',
              },
              user_id: {
                type: 'integer',
                description: 'Filter by acting user ID.',
              },
              entity_type: {
                type: 'string',
                enum: ['page', 'book', 'chapter', 'bookshelf', 'user', 'role'],
                description: 'Filter by affected entity type.',
              },
              entity_id: {
                type: 'integer',
                description: 'Filter by affected entity ID.',
              },
              date_from: {
                type: 'string',
                format: 'date',
                description: 'Start date (YYYY-MM-DD).',
              },
              date_to: {
                type: 'string',
                format: 'date',
                description: 'End date (YYYY-MM-DD).',
              },
            },
            description: 'Filters to narrow down the log.',
          },
        },
      },
      examples: [
        {
          description: 'Check who deleted a page',
          input: { filter: { event: 'page_delete', date_from: '2023-01-01' } },
          expected_output: 'List of deletion events',
          use_case: 'Security audit',
        }
      ],
      usage_patterns: [
        'Use to track down when a specific change happened',
      ],
      related_tools: ['bookstack_users_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Insufficient permissions',
          recovery_suggestion: 'Requires admin privileges',
        }
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing audit log entries', params);
        const validatedParams = this.validator.validateParams<any>(params, 'auditLogList');
        return await this.client.listAuditLog(validatedParams);
      },
    };
  }
}