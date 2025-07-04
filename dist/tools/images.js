"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageTools = void 0;
class ImageTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_images_list',
                description: 'List all images',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listImages(params),
            },
            // Additional image tools would be implemented here
        ];
    }
}
exports.ImageTools = ImageTools;
//# sourceMappingURL=images.js.map