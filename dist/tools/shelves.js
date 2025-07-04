"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShelfTools = void 0;
class ShelfTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_shelves_list',
                description: 'List all bookshelves',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listShelves(params),
            },
            // Additional shelf tools would be implemented here
        ];
    }
}
exports.ShelfTools = ShelfTools;
//# sourceMappingURL=shelves.js.map