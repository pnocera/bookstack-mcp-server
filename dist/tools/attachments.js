"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttachmentTools = void 0;
class AttachmentTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_attachments_list',
                description: 'List all attachments',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listAttachments(params),
            },
            // Additional attachment tools would be implemented here
        ];
    }
}
exports.AttachmentTools = AttachmentTools;
//# sourceMappingURL=attachments.js.map