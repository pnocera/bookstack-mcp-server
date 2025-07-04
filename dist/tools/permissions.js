"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionTools = void 0;
class PermissionTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_permissions_read',
                description: 'Get content permissions',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.getContentPermissions(params.content_type, params.content_id),
            },
            // Additional permission tools would be implemented here
        ];
    }
}
exports.PermissionTools = PermissionTools;
//# sourceMappingURL=permissions.js.map