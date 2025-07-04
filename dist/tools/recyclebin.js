"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecycleBinTools = void 0;
class RecycleBinTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_recycle_bin_list',
                description: 'List deleted items in recycle bin',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listRecycleBin(params),
            },
            // Additional recycle bin tools would be implemented here
        ];
    }
}
exports.RecycleBinTools = RecycleBinTools;
//# sourceMappingURL=recyclebin.js.map