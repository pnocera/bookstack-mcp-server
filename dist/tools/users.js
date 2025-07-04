"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserTools = void 0;
class UserTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_users_list',
                description: 'List all users',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listUsers(params),
            },
            // Additional user tools would be implemented here
        ];
    }
}
exports.UserTools = UserTools;
//# sourceMappingURL=users.js.map