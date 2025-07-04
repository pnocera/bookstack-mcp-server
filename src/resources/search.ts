import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';

export class SearchResources {
  constructor(
    private client: BookStackClient,
    private _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://search/{query}',
        name: 'Search',
        description: 'Search results for a specific query',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/search\/(.+)$/);
          if (!match) throw new Error('Invalid search resource URI');
          const query = decodeURIComponent(match[1]);
          return await this.client.search({ query });
        },
      },
    ];
  }
}