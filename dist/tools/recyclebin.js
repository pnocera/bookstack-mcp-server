"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecycleBinTools = void 0;
/**
 * Recycle bin management tools for BookStack MCP Server
 *
 * Provides 3 tools for recycle bin operations:
 * - List, restore, and permanently delete items
 */
class RecycleBinTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all recycle bin tools
     */
    getTools() {
        return [
            this.createListRecycleBinTool(),
            this.createRestoreFromRecycleBinTool(),
            this.createPermanentlyDeleteTool(),
        ];
    }
    /**
     * List recycle bin tool
     */
    createListRecycleBinTool() {
        return {
            name: 'bookstack_recyclebin_list',
            description: 'List items currently in the recycle bin. These items can be restored or permanently deleted.',
            category: 'recyclebin',
            inputSchema: {
                type: 'object',
                properties: {
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 500,
                        default: 20,
                        description: 'Number of items to return.',
                    },
                    offset: {
                        type: 'integer',
                        minimum: 0,
                        default: 0,
                        description: 'Pagination offset.',
                    },
                },
            },
            examples: [
                {
                    description: 'Check recycle bin',
                    input: { count: 10 },
                    expected_output: 'List of deleted items',
                    use_case: 'Finding accidental deletions',
                }
            ],
            usage_patterns: [
                'Use to find the `deletion_id` required for restoration',
            ],
            related_tools: ['bookstack_recyclebin_restore'],
            error_codes: [
                {
                    code: 'UNAUTHORIZED',
                    description: 'Insufficient permissions',
                    recovery_suggestion: 'Requires admin privileges',
                }
            ],
            handler: async (params) => {
                this.logger.debug('Listing recycle bin items', params);
                const validatedParams = this.validator.validateParams(params, 'recycleBinList');
                return await this.client.listRecycleBin(validatedParams);
            },
        };
    }
    /**
     * Restore from recycle bin tool
     */
    createRestoreFromRecycleBinTool() {
        return {
            name: 'bookstack_recyclebin_restore',
            description: 'Restore a deleted item from the recycle bin. Returns the item to its previous location.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'The `deletion_id` of the item to restore (Found via `bookstack_recyclebin_list`, NOT the original entity ID).',
                    },
                },
            },
            examples: [
                {
                    description: 'Restore an item',
                    input: { id: 105 },
                    expected_output: 'Success message',
                    use_case: 'Undoing a delete',
                }
            ],
            usage_patterns: [
                'Must use the ID from the recycle bin list, not the original book/page ID',
            ],
            related_tools: ['bookstack_recyclebin_list'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Deletion record not found',
                    recovery_suggestion: 'Check ID from list tool',
                }
            ],
            handler: async (params) => {
                const deletionId = this.validator.validateId(params.id);
                this.logger.info('Restoring from recycle bin', { deletion_id: deletionId });
                await this.client.restoreFromRecycleBin(deletionId);
                return { success: true, message: `Item ${deletionId} restored successfully` };
            },
        };
    }
    /**
     * Permanently delete tool
     */
    createPermanentlyDeleteTool() {
        return {
            name: 'bookstack_recyclebin_delete_permanently',
            description: 'Permanently delete an item from the recycle bin. This is destructive and cannot be undone.',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'The `deletion_id` of the item to purge.',
                    },
                },
            },
            examples: [
                {
                    description: 'Purge an item',
                    input: { id: 105 },
                    expected_output: 'Success message',
                    use_case: 'Privacy cleanup',
                }
            ],
            usage_patterns: [
                'Use with extreme caution',
            ],
            related_tools: ['bookstack_recyclebin_list'],
            error_codes: [
                {
                    code: 'NOT_FOUND',
                    description: 'Deletion record not found',
                    recovery_suggestion: 'Check ID',
                }
            ],
            handler: async (params) => {
                const deletionId = this.validator.validateId(params.id);
                this.logger.warn('Permanently deleting from recycle bin', { deletion_id: deletionId });
                await this.client.permanentlyDelete(deletionId);
                return { success: true, message: `Item ${deletionId} permanently deleted` };
            },
        };
    }
}
exports.RecycleBinTools = RecycleBinTools;
//# sourceMappingURL=recyclebin.js.map