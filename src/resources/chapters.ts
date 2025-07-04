import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';

export class ChapterResources {
  constructor(
    private client: BookStackClient,
    private _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://chapters',
        name: 'Chapters',
        description: 'All chapters in the BookStack instance',
        mimeType: 'application/json',
        handler: async (uri: string) => await this.client.listChapters(),
      },
      {
        uri: 'bookstack://chapters/{id}',
        name: 'Chapter',
        description: 'Specific chapter with pages',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/chapters\/(\d+)$/);
          if (!match) throw new Error('Invalid chapter resource URI');
          const id = parseInt(match[1]);
          return await this.client.getChapter(id);
        },
      },
    ];
  }
}