import type { BookStackClient } from '../api/client';
import type { MCPResource } from '../types';
import type { Logger } from '../utils/logger';

export class ChapterResources {
  constructor(
    private client: BookStackClient,
    _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://chapters',
        name: 'Chapters',
        description:
          "Chapters visible to the authenticated user, as a flat list. Returns BookStack's first page of results (100 chapters by default), not the whole instance, and each entry carries chapter metadata only - no pages. Takes no parameters; use the bookstack_chapters_list tool to paginate or filter.",
        mimeType: 'application/json',
        handler: async (_uri: string) => await this.client.listChapters(),
      },
      {
        uri: 'bookstack://chapters/{id}',
        name: 'Chapter',
        description:
          'A single chapter, including its tags and a `pages` array listing the pages it holds (names and ids, not page bodies). {id} must be a numeric chapter ID.',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/chapters\/(\d+)$/);
          if (!match) throw new Error('Invalid chapter resource URI');
          const id = parseInt(match[1], 10);
          return await this.client.getChapter(id);
        },
      },
    ];
  }
}
