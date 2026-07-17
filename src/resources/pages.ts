import type { BookStackClient } from '../api/client';
import type { MCPResource } from '../types';
import type { Logger } from '../utils/logger';

export class PageResources {
  constructor(
    private client: BookStackClient,
    _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://pages',
        name: 'Pages',
        description:
          "Pages visible to the authenticated user, as a flat list. Returns BookStack's first page of results (100 pages by default), not the whole instance, and each entry carries metadata only - page bodies are not included. Takes no parameters; use the bookstack_pages_list tool to paginate or filter.",
        mimeType: 'application/json',
        handler: async (_uri: string) => await this.client.listPages(),
      },
      {
        uri: 'bookstack://pages/{id}',
        name: 'Page',
        description:
          'A single page with its full content on `html`, plus tags. `markdown` holds the source only for pages written in the markdown editor and is an empty string for WYSIWYG pages, so `html` is the field to rely on. {id} must be a numeric page ID.',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/pages\/(\d+)$/);
          if (!match) throw new Error('Invalid page resource URI');
          const id = parseInt(match[1], 10);
          return await this.client.getPage(id);
        },
      },
    ];
  }
}
