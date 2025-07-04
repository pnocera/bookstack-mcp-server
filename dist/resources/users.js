"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserResources = void 0;
class UserResources {
    constructor(client, _logger) {
        this.client = client;
        this._logger = _logger;
    }
    getResources() {
        return [
            {
                uri: 'bookstack://users',
                name: 'Users',
                description: 'All users in the BookStack instance',
                mimeType: 'application/json',
                handler: async (uri) => await this.client.listUsers(),
            },
            {
                uri: 'bookstack://users/{id}',
                name: 'User',
                description: 'Specific user with roles',
                mimeType: 'application/json',
                handler: async (uri) => {
                    const match = uri.match(/^bookstack:\/\/users\/(\d+)$/);
                    if (!match)
                        throw new Error('Invalid user resource URI');
                    const id = parseInt(match[1]);
                    return await this.client.getUser(id);
                },
            },
        ];
    }
}
exports.UserResources = UserResources;
//# sourceMappingURL=users.js.map