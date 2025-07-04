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
            name: 'bookstack_recycle_bin_list',
            description: 'List all deleted items in the recycle bin with pagination options',
            category: 'recyclebin',
            inputSchema: {
                type: 'object',
                properties: {
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 500,
                        default: 20,
                        description: 'Number of deleted items to return',
                    },
                    offset: {
                        type: 'integer',
                        minimum: 0,
                        default: 0,
                        description: 'Number of deleted items to skip',
                    },
                },
            },
            examples: [
                {
                    description: 'List first 10 deleted items',
                    input: { count: 10 },
                    expected_output: 'Array of deleted item objects with deletion metadata',
                    use_case: 'Reviewing recently deleted content',
                },
                {
                    description: 'List all deleted items',
                    input: { count: 500 },
                    expected_output: 'All deleted items in the recycle bin',
                    use_case: 'Complete audit of deleted content',
                },
            ],
            usage_patterns: [
                'Use before restoring deleted content',
                'Regular cleanup of old deleted items',
                'Audit trail for deleted content',
            ],
            related_tools: ['bookstack_recycle_bin_restore', 'bookstack_recycle_bin_delete_permanently'],
            error_codes: [
                {
                    code: 'UNAUTHORIZED',
                    description: 'Authentication failed or insufficient permissions',
                    recovery_suggestion: 'Verify API token and admin permissions',
                },
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
            name: 'bookstack_recycle_bin_restore',
            description: 'Restore a deleted item from the recycle bin back to its original location',
            inputSchema: {
                type: 'object',
                required: ['deletion_id'],
                properties: {
                    deletion_id: {
                        type: 'integer',
                        description: 'Deletion ID of the item to restore (from recycle bin list)',
                    },
                },
            },
            examples: [
                {
                    description: 'Restore a deleted page',
                    input: { deletion_id: 42 },
                    expected_output: 'Confirmation of successful restoration',
                    use_case: 'Recovering accidentally deleted content',
                },
            ],
            usage_patterns: [
                'Restore accidentally deleted content',
                'Recover content after reviewing deletion',
                'Undo deletion operations',
            ],
            related_tools: ['bookstack_recycle_bin_list'],
            error_codes: [
                {
                    code: 'UNAUTHORIZED',
                    description: 'Authentication failed or insufficient permissions',
                    recovery_suggestion: 'Verify API token and admin permissions',
                },
                {
                    code: 'NOT_FOUND',
                    description: 'Deletion ID not found in recycle bin',
                    recovery_suggestion: 'Check deletion_id from recycle bin list',
                },
            ],
            handler: async (params) => {
                const deletionId = this.validator.validateId(params.deletion_id);
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
            name: 'bookstack_recycle_bin_delete_permanently',
            description: 'Permanently delete an item from the recycle bin (this action cannot be undone)',
            inputSchema: {
                type: 'object',
                required: ['deletion_id'],
                properties: {
                    deletion_id: {
                        type: 'integer',
                        description: 'Deletion ID of the item to permanently delete',
                    },
                },
            },
            examples: [
                {
                    description: 'Permanently delete an item',
                    input: { deletion_id: 42 },
                    expected_output: 'Confirmation of permanent deletion',
                    use_case: 'Final cleanup of unwanted content',
                },
            ],
            usage_patterns: [
                'Clean up old deleted content permanently',
                'Final removal of unwanted content',
                'Free up storage space',
            ],
            related_tools: ['bookstack_recycle_bin_list'],
            error_codes: [
                {
                    code: 'UNAUTHORIZED',
                    description: 'Authentication failed or insufficient permissions',
                    recovery_suggestion: 'Verify API token and admin permissions',
                },
                {
                    code: 'NOT_FOUND',
                    description: 'Deletion ID not found in recycle bin',
                    recovery_suggestion: 'Check deletion_id from recycle bin list',
                },
            ],
            handler: async (params) => {
                const deletionId = this.validator.validateId(params.deletion_id);
                this.logger.warn('Permanently deleting from recycle bin', { deletion_id: deletionId });
                await this.client.permanentlyDelete(deletionId);
                return { success: true, message: `Item ${deletionId} permanently deleted` };
            },
        };
    }
}
exports.RecycleBinTools = RecycleBinTools;
//# sourceMappingURL=recyclebin.js.map