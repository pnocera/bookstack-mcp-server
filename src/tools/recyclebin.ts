import type { BookStackClient } from '../api/client';
import { type MCPTool, type PaginationParams, withClosedSchemas } from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/**
 * Recycle bin management tools for BookStack MCP Server
 *
 * Provides 3 tools for recycle bin operations:
 * - List, restore, and permanently delete items
 */
export class RecycleBinTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all recycle bin tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListRecycleBinTool(),
      this.createRestoreFromRecycleBinTool(),
      this.createPermanentlyDeleteTool(),
    ]);
  }

  /**
   * List recycle bin tool
   */
  private createListRecycleBinTool(): MCPTool {
    return {
      name: 'bookstack_recyclebin_list',
      description:
        'List items currently in the recycle bin, so they can be restored or permanently deleted. This is a top-level listing: deleting a book creates one entry for the book, not extra entries for the chapters and pages inside it. Each entry carries the deleted item under `deletable`, with `pages_count`/`chapters_count` for books and chapters.',
      category: 'recyclebin',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description:
              "Number of items to return, 1-500. 500 is BookStack's own maximum; a larger value is REJECTED here rather than clamped to it, so ask for at most 500 and page through the rest with offset.",
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
              'deletable_type',
              '-deletable_type',
              'deletable_id',
              '-deletable_id',
            ],
            default: '-created_at',
            description:
              'Sort field. A leading "-" sorts descending, so the default "-created_at" lists the most recently deleted first. `created_at` is when the item was deleted - there is no `deleted_at` field on these entries.',
          },
        },
      },
      examples: [
        {
          description: 'Check recycle bin',
          input: { count: 10 },
          expected_output: 'The 10 most recently deleted items, newest first',
          use_case: 'Finding accidental deletions',
        },
        {
          description: 'Find the oldest deletions still held',
          input: { count: 5, sort: 'created_at' },
          expected_output: 'The 5 longest-standing entries, oldest first',
          use_case: 'Deciding what is safe to purge',
        },
      ],
      usage_patterns: [
        'Use to find the `id` of a deletion, which is what the restore and purge tools take - it is NOT the id of the deleted book/page itself',
        'Match an entry to the item you deleted with `deletable_type` + `deletable_id`',
      ],
      related_tools: ['bookstack_recyclebin_restore', 'bookstack_recyclebin_delete_permanently'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Insufficient permissions',
          recovery_suggestion:
            'Requires permission to manage both system settings and all content permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<PaginationParams>(
          params,
          'recycleBinList'
        );
        // After validation, and pagination only - this listing takes no filter. See the
        // same line in src/tools/books.ts for why the raw request no longer goes to the log.
        this.logger.debug('Listing recycle bin items', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
        });
        return await this.client.listRecycleBin(validatedParams);
      },
    };
  }

  /**
   * Restore from recycle bin tool
   */
  private createRestoreFromRecycleBinTool(): MCPTool {
    return {
      name: 'bookstack_recyclebin_restore',
      description:
        'Restore a deleted item from the recycle bin, returning it to its previous location. Restoring a book or chapter also restores the chapters and pages that were deleted with it, and removes the entry from the bin.',
      category: 'recyclebin',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description:
              "The `id` of the recycle bin entry to restore, as returned by `bookstack_recyclebin_list`. This is the deletion record's own id, NOT the id of the deleted book/page (those are `deletable_id`).",
          },
        },
      },
      examples: [
        {
          description: 'Restore an item',
          input: { id: 105 },
          expected_output:
            '{ success: true, restore_count: 3, message: "Recycle bin entry 105 restored, bringing back 3 item(s)" }',
          use_case: 'Undoing a delete',
        },
      ],
      usage_patterns: [
        'List the bin first: the id here is the entry id, not the original book/page id',
        'Check `restore_count` to see how much came back: one entry can restore a whole subtree, so restoring a deleted book also restores the chapters and pages deleted with it.',
      ],
      related_tools: ['bookstack_recyclebin_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No recycle bin entry with that id',
          recovery_suggestion:
            "Take the id from bookstack_recyclebin_list; passing the deleted item's own id instead is the usual cause",
        },
      ],
      handler: async (params: unknown) => {
        const { id: deletionId } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.info('Restoring from recycle bin', { deletion_id: deletionId });
        const { restore_count } = await this.client.restoreFromRecycleBin(deletionId);
        return {
          success: true,
          restore_count,
          message: `Recycle bin entry ${deletionId} restored, bringing back ${restore_count} item(s)`,
        };
      },
    };
  }

  /**
   * Permanently delete tool
   */
  private createPermanentlyDeleteTool(): MCPTool {
    return {
      name: 'bookstack_recyclebin_delete_permanently',
      description:
        'Permanently destroy one recycle bin entry and the content it holds. This cannot be undone: purging a book also destroys the chapters and pages deleted with it. Restore instead if the content might still be wanted.',
      category: 'recyclebin',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description:
              "The `id` of the recycle bin entry to purge, as returned by `bookstack_recyclebin_list`. This is the deletion record's own id, NOT the id of the deleted book/page.",
          },
        },
      },
      examples: [
        {
          description: 'Purge an item',
          input: { id: 105 },
          expected_output:
            '{ success: true, delete_count: 3, message: "Recycle bin entry 105 permanently deleted, destroying 3 item(s)" }',
          use_case: 'Privacy cleanup',
        },
      ],
      usage_patterns: [
        'Purges exactly one entry - it is not an "empty the bin" tool, so other entries are untouched',
        '`delete_count` reports how many items were actually destroyed: purging one entry for a deleted book destroys its chapters and pages too, so the count is routinely larger than 1.',
        'Confirm with bookstack_recyclebin_list which entry an id refers to before purging: the loss is irreversible',
      ],
      related_tools: ['bookstack_recyclebin_list', 'bookstack_recyclebin_restore'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No recycle bin entry with that id',
          recovery_suggestion: 'Take the id from bookstack_recyclebin_list',
        },
      ],
      handler: async (params: unknown) => {
        const { id: deletionId } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Permanently deleting from recycle bin', { deletion_id: deletionId });
        const { delete_count } = await this.client.permanentlyDelete(deletionId);
        return {
          success: true,
          delete_count,
          message: `Recycle bin entry ${deletionId} permanently deleted, destroying ${delete_count} item(s)`,
        };
      },
    };
  }
}
