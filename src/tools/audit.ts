import type { BookStackClient } from '../api/client';
import {
  type AuditLogListInput,
  type MCPTool,
  toAuditLogListParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { ValidationHandler } from '../validation/validator';

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
    return withClosedSchemas([this.createListAuditLogTool()]);
  }

  /**
   * List audit log tool
   */
  private createListAuditLogTool(): MCPTool {
    return {
      name: 'bookstack_audit_log_list',
      description:
        'Retrieve the audit log to see recent activities on the instance. Returns the most recent entries first by default. Each entry carries type, detail, user_id, ip, created_at and the affected item as loggable_type/loggable_id - both of which are null for events that target no content item. Requires a token whose user can manage both users and system settings.',
      // 'system', not 'audit': this is the category `getToolCategories()` actually files
      // this tool under, and the one `bookstack_tool_categories` can answer for. Claiming
      // a category that does not exist made the tool advertise a lookup that always
      // returned "Category not found".
      category: 'system',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description:
              "Number of entries to return, 1-500. 500 is BookStack's own maximum; a larger value is REJECTED here rather than clamped to it, so ask for at most 500 and page through the rest with offset.",
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Pagination offset.',
          },
          sort: {
            type: 'string',
            enum: [
              '-created_at',
              'created_at',
              '-id',
              'id',
              '-type',
              'type',
              '-user_id',
              'user_id',
            ],
            default: '-created_at',
            description:
              'Sort field. A leading "-" sorts descending, so the default "-created_at" is most recent first; plain "created_at" is oldest first.',
          },
          filter: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description:
                  'Filter by the event type, matched exactly (e.g. "page_create", "page_update", "book_delete").',
              },
              user_id: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by acting user ID.',
              },
              loggable_type: {
                type: 'string',
                description:
                  'Filter by the type of the affected item, matched exactly. BookStack only records this for its core content types: "page", "book", "chapter" or "bookshelf". Entries for other events (logins, role changes) have it null and can never match.',
              },
              loggable_id: {
                type: 'integer',
                minimum: 1,
                description:
                  'Filter by the ID of the affected item. Best combined with loggable_type, since IDs are only unique within a type.',
              },
              date_from: {
                type: 'string',
                description:
                  'Only entries at or after this time. Accepts a date ("2026-07-16") or a date-time ("2026-07-16 09:20:00").',
              },
              date_to: {
                type: 'string',
                description:
                  'Only entries at or before this time. Accepts a date ("2026-07-16") or a date-time ("2026-07-16 09:20:00"). A bare date resolves to that day at 00:00:00.',
              },
            },
            description:
              'Filters to narrow down the log. Every filter listed is applied by BookStack; anything it does not recognise would be ignored, so only these are accepted.',
          },
        },
      },
      examples: [
        {
          description: 'Check who deleted pages this month',
          input: { filter: { type: 'page_delete', date_from: '2026-07-01' } },
          expected_output: 'List of page deletion events, most recent first',
          use_case: 'Security audit',
        },
        {
          description: 'Trace everything that happened to one page',
          input: { filter: { loggable_type: 'page', loggable_id: 42 } },
          expected_output: 'The create/update/delete events for page 42',
          use_case: 'Reconstructing the history of a single document',
        },
      ],
      usage_patterns: [
        'Use to track down when a specific change happened',
        'Filter by `type` for a kind of event, or by `loggable_type` + `loggable_id` for one specific item.',
        'Every filter is an exact match; there is no partial or wildcard matching here. `type` must be the whole event name, so "page" matches nothing while "page_update" matches.',
        "Purging an item from the recycle bin nulls loggable_id/loggable_type on every entry for it and sets their `detail` to the item's name. Items merely deleted (still in the bin) keep them, so `loggable_id` only finds live or recoverable content - trace purged content by `type` + `detail`.",
      ],
      related_tools: ['bookstack_users_list', 'bookstack_recyclebin_list'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Insufficient permissions',
          recovery_suggestion:
            'Requires permission to manage both users and system settings, which is typically an admin token',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<AuditLogListInput>(
          params,
          'auditLogList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts - and
        // note that an audit filter names a person (`user_id`) and a date range, which is
        // exactly the shape of query whose VALUES an operator's log has no business keeping.
        this.logger.debug('Listing audit log entries', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        // date_from/date_to are ours; BookStack only understands them as
        // `created_at` filter operators.
        return await this.client.listAuditLog(toAuditLogListParams(validatedParams));
      },
    };
  }
}
