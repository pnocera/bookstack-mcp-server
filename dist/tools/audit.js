"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditTools = void 0;
class AuditTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_audit_log_list',
                description: 'List audit log entries',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listAuditLog(params),
            },
            // Additional audit tools would be implemented here
        ];
    }
}
exports.AuditTools = AuditTools;
//# sourceMappingURL=audit.js.map