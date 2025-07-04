"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChapterTools = void 0;
class ChapterTools {
    constructor(client, _validator, _logger) {
        this.client = client;
        this._validator = _validator;
        this._logger = _logger;
    }
    getTools() {
        return [
            {
                name: 'bookstack_chapters_list',
                description: 'List all chapters with pagination and filtering',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.listChapters(params),
            },
            {
                name: 'bookstack_chapters_create',
                description: 'Create a new chapter',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.createChapter(params),
            },
            {
                name: 'bookstack_chapters_read',
                description: 'Get chapter details with pages',
                inputSchema: { type: 'object', properties: {} },
                handler: async (params) => this.client.getChapter(params.id),
            },
            // Additional chapter tools would be implemented here
        ];
    }
}
exports.ChapterTools = ChapterTools;
//# sourceMappingURL=chapters.js.map