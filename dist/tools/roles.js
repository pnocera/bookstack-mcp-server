"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoleTools = void 0;
class RoleTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_roles_list',
                description: 'List all roles',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listRoles(params),
            },
            // Additional role tools would be implemented here
        ];
    }
}
exports.RoleTools = RoleTools;
//# sourceMappingURL=roles.js.map