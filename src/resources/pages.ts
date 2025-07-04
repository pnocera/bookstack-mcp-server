import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';

export class PageResources {
  constructor(
    private client: BookStackClient,
    private _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://pages',
        name: 'Pages',
        description: 'All pages in the BookStack instance',
        mimeType: 'application/json',
        handler: async (uri: string) => await this.client.listPages(),
      },
      {
        uri: 'bookstack://pages/{id}',
        name: 'Page',
        description: 'Specific page with full content',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/pages\/(\d+)$/);
          if (!match) throw new Error('Invalid page resource URI');
          const id = parseInt(match[1]);
          return await this.client.getPage(id);
        },
      },
    ];
  }
}