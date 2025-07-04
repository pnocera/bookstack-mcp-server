"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChapterResources = void 0;
class ChapterResources {
    constructor(client, _logger) {
        this.client = client;
        this._logger = _logger;
    }
    getResources() {
        return [
            {
                uri: 'bookstack://chapters',
                name: 'Chapters',
                description: 'All chapters in the BookStack instance',
                mimeType: 'application/json',
                handler: async (uri) => await this.client.listChapters(),
            },
            {
                uri: 'bookstack://chapters/{id}',
                name: 'Chapter',
                description: 'Specific chapter with pages',
                mimeType: 'application/json',
                handler: async (uri) => {
                    const match = uri.match(/^bookstack:\/\/chapters\/(\d+)$/);
                    if (!match)
                        throw new Error('Invalid chapter resource URI');
                    const id = parseInt(match[1]);
                    return await this.client.getChapter(id);
                },
            },
        ];
    }
}
exports.ChapterResources = ChapterResources;
//# sourceMappingURL=chapters.js.map