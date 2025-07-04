import { BookStackClient } from '../api/client';
import { Logger } from '../utils/logger';
import { MCPResource } from '../types';

export class UserResources {
  constructor(
    private client: BookStackClient,
    private _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://users',
        name: 'Users',
        description: 'All users in the BookStack instance',
        mimeType: 'application/json',
        handler: async (uri: string) => await this.client.listUsers(),
      },
      {
        uri: 'bookstack://users/{id}',
        name: 'User',
        description: 'Specific user with roles',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/users\/(\d+)$/);
          if (!match) throw new Error('Invalid user resource URI');
          const id = parseInt(match[1]);
          return await this.client.getUser(id);
        },
      },
    ];
  }
}