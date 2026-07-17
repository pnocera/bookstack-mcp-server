import type { BookStackClient } from '../api/client';
import type { MCPResource } from '../types';
import type { Logger } from '../utils/logger';

export class UserResources {
  constructor(
    private client: BookStackClient,
    _logger: Logger
  ) {}

  getResources(): MCPResource[] {
    return [
      {
        uri: 'bookstack://users',
        name: 'Users',
        description:
          "Users of the BookStack instance, as a flat list. Returns BookStack's first page of results (100 users by default), and each entry carries user metadata only - no roles. Requires the API token to hold the users-manage permission, otherwise the read fails. Takes no parameters; use the bookstack_users_list tool to paginate or filter.",
        mimeType: 'application/json',
        handler: async (_uri: string) => await this.client.listUsers(),
      },
      {
        uri: 'bookstack://users/{id}',
        name: 'User',
        description:
          'A single user, including the `roles` they hold. Requires the API token to hold the users-manage permission. {id} must be a numeric user ID.',
        mimeType: 'application/json',
        handler: async (uri: string) => {
          const match = uri.match(/^bookstack:\/\/users\/(\d+)$/);
          if (!match) throw new Error('Invalid user resource URI');
          const id = parseInt(match[1], 10);
          return await this.client.getUser(id);
        },
      },
    ];
  }
}
