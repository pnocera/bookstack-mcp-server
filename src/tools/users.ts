import type { BookStackClient } from '../api/client';
import {
  type CreateUserParams,
  LANGUAGE_PATTERN,
  type MCPTool,
  NONBLANK_PATTERN,
  type UpdateUserParams,
  type UsersListParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, UserDeleteRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_users_update` request: the user to update, plus the changes. */
type UpdateUserRequest = UpdateUserParams & IdRequest;

/**
 * User management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete user lifecycle management:
 * - List, create, read, update, and delete users
 */
export class UserTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all user tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListUsersTool(),
      this.createCreateUserTool(),
      this.createReadUserTool(),
      this.createUpdateUserTool(),
      this.createDeleteUserTool(),
    ]);
  }

  /**
   * List users tool
   */
  private createListUsersTool(): MCPTool {
    return {
      name: 'bookstack_users_list',
      description:
        'List the people who can log in to BookStack. Returns a paginated {data, total} listing of accounts; use bookstack_roles_list instead for the roles those accounts are assigned.',
      category: 'users',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of users to return.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Pagination offset.',
          },
          sort: {
            type: 'string',
            enum: [
              'name',
              'email',
              'created_at',
              'updated_at',
              '-name',
              '-email',
              '-created_at',
              '-updated_at',
            ],
            default: 'name',
            description: 'Sort field. Prefix with "-" to reverse the direction.',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by exact name (not a substring of it).',
              },
              email: {
                type: 'string',
                description: 'Filter by exact email address.',
              },
            },
            description:
              'Filters, matched exactly. A value that matches nothing yields an empty `data` array rather than an error.',
          },
        },
      },
      examples: [
        {
          description: 'Find a user by their exact email address',
          input: { filter: { email: 'alice@example.com' } },
          expected_output:
            '{ data: [ { id, name, email, slug, external_auth_id, last_activity_at, ... } ], total: 1 } - `data` is empty when no account has that address',
          use_case: 'Resolving a person to their user id before reading or updating them',
        },
        {
          description: 'Most recently created accounts first',
          input: { sort: '-created_at', count: 10 },
          expected_output: 'The 10 newest users, in a { data, total } listing',
          use_case: 'Reviewing recent onboarding',
        },
      ],
      usage_patterns: [
        'Use to check whether an account exists, and to turn a name or email into the id every other user tool needs.',
        'The listing carries no role information: read a single user with `bookstack_users_read` to see their roles.',
      ],
      related_tools: ['bookstack_users_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'The API token lacks the "users-manage" permission BookStack requires here',
          recovery_suggestion:
            'Use a token belonging to a user whose role grants "users-manage" (the Admin role has it)',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<UsersListParams>(params, 'usersList');
        // The filter's KEYS, not its values: `filter[email]` is how you look a person up by
        // address, so the value here is exactly the PII the create call no longer logs.
        // Logged after validation rather than before, so the names come from the schema.
        this.logger.debug('Listing users', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listUsers(validatedParams);
      },
    };
  }

  /**
   * Create user tool
   */
  private createCreateUserTool(): MCPTool {
    return {
      name: 'bookstack_users_create',
      description:
        'Create a new user account. Requires name and email; a password and roles are optional. A user with no roles can sign in but sees nothing, so pass `roles` (resolve the ids with bookstack_roles_list) unless that is what you want.',
      inputSchema: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            maxLength: 100,
            description:
              'Display name. Must contain a non-whitespace character. BookStack rejects anything longer than 100 characters.',
          },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 191,
            description:
              'Email address. Must be unique across users, and is stored in a 191-character column.',
          },
          password: {
            type: 'string',
            minLength: 8,
            description:
              'Initial password, at least 8 characters. Optional: an account created without one has no usable password until it is set here, through a reset, or by external auth.',
          },
          roles: {
            type: 'array',
            items: {
              type: 'integer',
              minimum: 1,
            },
            description: 'Role IDs to assign, from bookstack_roles_list.',
          },
          send_invite: {
            type: 'boolean',
            default: false,
            description:
              'Email the new user an invitation to set their own password. Requires BookStack to have working mail settings; the call fails with a server error if it does not.',
          },
          external_auth_id: {
            type: 'string',
            maxLength: 191,
            description:
              'External ID used to match this account to an LDAP/SAML/OIDC identity. Stored in a 191-character column.',
          },
          language: {
            type: 'string',
            // BookStack's `alpha_dash`, stated machine-readably rather than only in the
            // prose below - a schema-driven client had no way to know 'fr FR' is
            // invalid. The anchored pattern also implies non-blankness.
            // See LANGUAGE_PATTERN for the live evidence and for the one case where
            // this is stricter than upstream (a blank language is ignored there).
            minLength: 1,
            pattern: LANGUAGE_PATTERN,
            maxLength: 15,
            description:
              'Interface language for this user, e.g. "fr" or "pt_BR". Letters, numbers, dashes and underscores only. BookStack stores this as a user setting rather than a column, so no response ever echoes it back - not this call, and not bookstack_users_read. An unrecognised but well-formed code is accepted and simply falls back to the instance default when rendering. Omit to leave the user on the instance default.',
          },
        },
      },
      examples: [
        {
          description: 'Create a standard user with a password and one role',
          input: {
            name: 'John Doe',
            email: 'john@example.com',
            password: 'securePassword123',
            roles: [2],
          },
          expected_output:
            'The created user: { id, name, email, slug, external_auth_id, created_at, ... }',
          use_case: 'Onboarding new team members',
        },
      ],
      usage_patterns: [
        'Role ids are per-instance: list roles first rather than assuming an id like 2 is "Editor".',
        'The email must be unique; creating with one already in use fails validation rather than updating the existing account.',
      ],
      related_tools: ['bookstack_roles_list', 'bookstack_users_update'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Email already taken, name over 100 characters, or password under 8 characters',
          recovery_suggestion:
            'Look the address up with bookstack_users_list before creating; shorten the name; lengthen the password',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateUserParams>(
          params,
          'userCreate'
        );
        // WHICH fields were sent, never what was in them. R5-W3 found this line writing a
        // person's name and email address at `info`: both are personal data, and an email
        // address is an account identifier as well. `fields` still distinguishes the calls
        // that matter operationally - with or without a password, with or without roles -
        // and every name in it came back out of a strict schema rather than off the wire.
        this.logger.info('Creating user', {
          fields: Object.keys(validatedParams).sort(),
          roles: validatedParams.roles?.length ?? 0,
        });
        return await this.client.createUser(validatedParams);
      },
    };
  }

  /**
   * Read user tool
   */
  private createReadUserTool(): MCPTool {
    return {
      name: 'bookstack_users_read',
      description:
        'Get one user by id, including the roles they hold. This is the only user tool that reports roles - the listing does not.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description:
              'ID of the user. Resolve a name or email to an id with bookstack_users_list.',
          },
        },
      },
      examples: [
        {
          description: 'Read a user and see which roles they hold',
          input: { id: 5 },
          expected_output:
            'The user, whose `roles` is an array of { id, display_name } references rather than full role objects: { id, name, email, slug, roles: [ { id, display_name } ], ... }',
          use_case: 'Checking what an account can do before changing it',
        },
      ],
      usage_patterns: [
        'Read before updating `roles`: the update replaces the whole set, so this is where you get the current one to add to.',
        "For a role's full definition (its permissions), take the id from `roles` here and pass it to `bookstack_roles_read`.",
      ],
      related_tools: ['bookstack_users_list', 'bookstack_roles_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No user has that id',
          recovery_suggestion: 'Confirm the id with bookstack_users_list',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading user', { id });
        return await this.client.getUser(id);
      },
    };
  }

  /**
   * Update user tool
   */
  private createUpdateUserTool(): MCPTool {
    return {
      name: 'bookstack_users_update',
      description:
        "Update an existing user's profile or roles, by id. Only the fields you send change. Note that BookStack's API cannot activate or deactivate a user - to revoke access, either remove their roles or delete the account.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the user to update.',
          },
          name: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            maxLength: 100,
            description:
              'New display name. Must contain a non-whitespace character. BookStack rejects anything longer than 100 characters.',
          },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 191,
            description: 'New email address. Must stay unique across users.',
          },
          password: {
            type: 'string',
            minLength: 8,
            description: 'New password, at least 8 characters.',
          },
          roles: {
            type: 'array',
            items: {
              type: 'integer',
              minimum: 1,
            },
            description:
              'The complete new set of role IDs. This REPLACES the existing roles rather than adding to them; `[]` leaves the account with none.',
          },
          external_auth_id: {
            type: 'string',
            maxLength: 191,
            description: 'External ID used to match this account to an LDAP/SAML/OIDC identity.',
          },
          language: {
            type: 'string',
            // BookStack's `alpha_dash`, stated machine-readably rather than only in the
            // prose below - a schema-driven client had no way to know 'fr FR' is
            // invalid. The anchored pattern also implies non-blankness.
            // See LANGUAGE_PATTERN for the live evidence and for the one case where
            // this is stricter than upstream (a blank language is ignored there).
            minLength: 1,
            pattern: LANGUAGE_PATTERN,
            maxLength: 15,
            description:
              'New interface language for this user, e.g. "fr" or "pt_BR". Letters, numbers, dashes and underscores only. BookStack stores this as a user setting rather than a column, so the response does not echo it back and bookstack_users_read cannot be used to confirm it.',
          },
        },
      },
      examples: [
        {
          description: 'Move a user onto a different set of roles',
          input: { id: 5, roles: [3] },
          expected_output: 'The updated user, now holding only role 3',
          use_case: 'Changing what someone is allowed to do',
        },
      ],
      usage_patterns: [
        'To append a role, read the user first to get current roles, add the new one, and then update.',
        'There is no `active` flag: BookStack stores no such field on a user. For offboarding, strip their roles with this tool or remove the account with `bookstack_users_delete`.',
      ],
      related_tools: ['bookstack_users_read', 'bookstack_users_delete'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No user has that id',
          recovery_suggestion: 'Confirm the id with bookstack_users_list',
        },
        {
          code: 'VALIDATION_ERROR',
          description:
            'Email already taken by another account, name over 100 characters, or password under 8 characters',
          recovery_suggestion: 'Shorten the name, lengthen the password, or pick a free address',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema.
        const { id, ...updateParams } = this.validator.validateParams<UpdateUserRequest>(
          params,
          'userUpdate'
        );
        this.logger.info('Updating user', {
          id,
          fields: Object.keys(updateParams),
        });
        return await this.client.updateUser(id, updateParams);
      },
    };
  }

  /**
   * Delete user tool
   */
  private createDeleteUserTool(): MCPTool {
    return {
      name: 'bookstack_users_delete',
      description:
        'Permanently delete a user account, optionally handing their content to someone else first. Users do NOT go through the recycle bin: unlike a book or page, a deleted user cannot be restored. Their content is never deleted with them - it survives either way, and only its ownership is at stake. The heir, when given, must be a different account from the one being deleted.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the user to delete.',
          },
          migrate_ownership_id: {
            type: 'integer',
            minimum: 1,
            description:
              'ID of an existing user who will inherit everything the deleted user owned (books, chapters, pages, shelves). Must be a DIFFERENT user from `id`: BookStack deletes the account before it looks the heir up, so naming the deleted user as its own heir leaves all of their content unowned while still reporting success - this server rejects that combination rather than performing it. Omit it and that content is left with no owner instead. An id that matches no user is ignored silently - the deletion still goes ahead and the content ends up unowned - so resolve the heir with bookstack_users_list first.',
          },
        },
      },
      examples: [
        {
          description: 'Delete a user and hand their content to another account',
          input: { id: 5, migrate_ownership_id: 1 },
          expected_output: '{ success: true, message: "User 5 deleted successfully" }',
          use_case: 'Removing a former employee while keeping their work owned by a real person',
        },
      ],
      usage_patterns: [
        'Migrate ownership whenever the user created anything: without it their books and pages stay in place but show no owner, which is awkward to undo once the account is gone.',
        'Deletion is permanent and has no recycle-bin entry to restore from, so confirm the id with `bookstack_users_read` before calling.',
        'The heir must be someone else. `{id: 5, migrate_ownership_id: 5}` is refused here without contacting BookStack, because upstream would accept it, delete user 5, then fail to find user 5 to hand the content to.',
      ],
      related_tools: ['bookstack_users_list', 'bookstack_users_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No user has that id',
          recovery_suggestion: 'Confirm the id with bookstack_users_list',
        },
        {
          code: 'VALIDATION_ERROR',
          description:
            'migrate_ownership_id is the same user as id, which can only ever leave their content unowned',
          recovery_suggestion:
            'Name a different existing user as the heir, or omit migrate_ownership_id if unowned content is genuinely intended',
        },
      ],
      handler: async (params: unknown) => {
        // The heir is validated here or nowhere: BookStack's own delete() never runs the
        // `exists:users,id` rule it declares, and this delete is irreversible.
        const { id, migrate_ownership_id: migrateOwnershipId } =
          this.validator.validateParams<UserDeleteRequest>(params, 'userDelete');
        this.logger.warn('Deleting user', { id, migrate_to: migrateOwnershipId });
        await this.client.deleteUser(id, migrateOwnershipId);
        return { success: true, message: `User ${id} deleted successfully` };
      },
    };
  }
}
