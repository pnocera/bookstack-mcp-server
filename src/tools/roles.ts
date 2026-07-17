import type { BookStackClient } from '../api/client';
import {
  type CreateRoleParams,
  type MCPTool,
  type RolesListInput,
  toRolesListParams,
  trimmedMinLengthPattern,
  type UpdateRoleParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_roles_update` request: the role to update, plus the changes. */
type UpdateRoleRequest = UpdateRoleParams & IdRequest;

/**
 * Role management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete role lifecycle management:
 * - List, create, read, update, and delete roles
 */
export class RoleTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all role tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListRolesTool(),
      this.createCreateRoleTool(),
      this.createReadRoleTool(),
      this.createUpdateRoleTool(),
      this.createDeleteRoleTool(),
    ]);
  }

  /**
   * List roles tool
   */
  private createListRolesTool(): MCPTool {
    return {
      name: 'bookstack_roles_list',
      description:
        'List the roles defined in this instance. A role is a named set of system permissions (e.g. "Editor", "Admin") that gets assigned to users - use bookstack_users_list for the people themselves. Every role in the listing carries its own `mfa_enforced`, `users_count` and `permissions_count`.',
      category: 'roles',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of roles to return.',
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
              'display_name',
              'created_at',
              'updated_at',
              '-display_name',
              '-created_at',
              '-updated_at',
            ],
            default: 'display_name',
            description: 'Sort field. Prefix with "-" to reverse the direction.',
          },
          filter: {
            type: 'object',
            properties: {
              display_name: {
                type: 'string',
                description: 'Filter by exact display name (not a substring of it).',
              },
              description: {
                type: 'string',
                description: 'Filter by exact description.',
              },
              external_auth_id: {
                type: 'string',
                description: 'Filter by exact external auth ID (LDAP/SSO).',
              },
              mfa_enforced: {
                type: 'boolean',
                description: 'Filter by whether the role enforces MFA.',
              },
            },
            description:
              "Filters, matched exactly. BookStack does not expose a role's system_name for filtering or sorting, so it cannot be used here.",
          },
        },
      },
      examples: [
        {
          description: 'List every role',
          input: {},
          expected_output:
            '{ data: [ { id, display_name, description, system_name, mfa_enforced, users_count, permissions_count, ... } ], total }',
          use_case: 'Checking which roles exist before assigning one',
        },
        {
          description: 'Find a role by its exact display name',
          input: { filter: { display_name: 'Editor' } },
          expected_output: 'A { data, total } listing holding the matching role, or empty if none',
          use_case: 'Resolving a role ID before assigning it to a user',
        },
      ],
      usage_patterns: [
        'Use to turn a role name into the id that `bookstack_users_create` / `bookstack_users_update` need - ids are per-instance and must not be guessed.',
        'The listing gives permission *counts* only; `bookstack_roles_read` returns the actual permission names.',
      ],
      related_tools: ['bookstack_users_create', 'bookstack_roles_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description:
            'The API token lacks the "user-roles-manage" permission BookStack requires here',
          recovery_suggestion:
            'Use a token belonging to a user whose role grants "user-roles-manage" (the Admin role has it)',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<RolesListInput>(params, 'rolesList');
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing roles', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        // mfa_enforced is a boolean to callers; BookStack's tinyint column only
        // compares correctly against 1/0.
        return await this.client.listRoles(toRolesListParams(validatedParams));
      },
    };
  }

  /**
   * Create role tool
   */
  private createCreateRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_create',
      description:
        'Create a new role: a named set of system permissions that can then be assigned to users with bookstack_users_create / bookstack_users_update. Creating a role assigns it to nobody.',
      inputSchema: {
        type: 'object',
        required: ['display_name'],
        properties: {
          display_name: {
            type: 'string',
            minLength: 3,
            // The minimum, stated as BookStack applies it: AFTER trimming. `minLength: 3`
            // counts raw characters, so '   a' satisfied it while upstream 422s on the one
            // character it keeps (see trimmedMinLengthPattern in src/types.ts for the live
            // evidence). The pattern says the same thing in a form JSON Schema can express,
            // so a client generating from this contract is not offered a call the server
            // would forward only to have it refused. Both keywords stay: the pattern
            // implies the minLength, and the minLength is what a generator reads.
            pattern: trimmedMinLengthPattern(3),
            maxLength: 180,
            description:
              'Name of the role. BookStack requires 3 to 180 characters, counted AFTER it trims the value - so "   a" is rejected as one character, not accepted as four.',
          },
          description: {
            type: 'string',
            maxLength: 180,
            description: 'Short description.',
          },
          mfa_enforced: {
            type: 'boolean',
            default: false,
            description: 'Require MFA for users in this role.',
          },
          external_auth_id: {
            type: 'string',
            maxLength: 180,
            description: 'External ID for LDAP/SSO syncing.',
          },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'System-level permissions to grant, as an array of permission-name strings (e.g. ["content-export", "users-manage"]). Only the names listed are granted; omitted ones are not. Names BookStack does not recognise are dropped without an error, so a typo silently grants nothing.',
          },
        },
      },
      examples: [
        {
          description: 'Create a role that can export content but little else',
          input: { display_name: 'Junior Editor', permissions: ['content-export'] },
          expected_output:
            'The created role: { id, display_name, mfa_enforced, permissions: ["content-export"], users: [], created_at, updated_at }. Note the absent description and system_name - create echoes back only the fields that were actually set.',
          use_case: 'Defining new access levels',
        },
      ],
      usage_patterns: [
        'Copy the permission names from an existing role via `bookstack_roles_read` rather than inventing them: unknown names are silently ignored.',
        'The create response carries only the fields that were set, so one you omitted (description, external_auth_id) is absent rather than null, and `system_name` never appears at all. Read the role back with `bookstack_roles_read` if you need its settled shape - there, description is null and the others are empty strings.',
      ],
      related_tools: ['bookstack_roles_list', 'bookstack_roles_read'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'display_name missing, shorter than 3 characters once trimmed, or longer than 180 (description and external_auth_id also cap at 180)',
          recovery_suggestion:
            'Provide a display_name of 3-180 characters, counting only what survives trimming',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateRoleParams>(
          params,
          'roleCreate'
        );
        // The name's size, not the name. See the same line in src/tools/books.ts.
        this.logger.info('Creating role', {
          display_name_length: validatedParams.display_name.length,
        });
        return await this.client.createRole(validatedParams);
      },
    };
  }

  /**
   * Read role tool
   */
  private createReadRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_read',
      description:
        'Get one role by id, with its full list of system permission names and a summary of the users assigned to it. The listing tool only reports counts, so this is where the actual permissions come from.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the role. Resolve a role name to an id with bookstack_roles_list.',
          },
        },
      },
      examples: [
        {
          description: 'Read a role to see exactly what it grants',
          input: { id: 3 },
          expected_output:
            'The role, with `permissions` as an array of permission-name strings and `users` as the accounts holding it: { id, display_name, permissions: ["content-export", ...], users: [ { id, name, slug } ], ... }',
          use_case: 'Auditing what a role can do, and who has it',
        },
      ],
      usage_patterns: [
        'Call this before `bookstack_roles_update`: that tool replaces the permission set wholesale, so you need the current names to keep any of them.',
      ],
      related_tools: ['bookstack_roles_list', 'bookstack_roles_update'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No role has that id',
          recovery_suggestion: 'Confirm the id with bookstack_roles_list',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading role', { id });
        return await this.client.getRole(id);
      },
    };
  }

  /**
   * Update role tool
   */
  private createUpdateRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_update',
      description:
        "Update an existing role's name, description, or permissions, by id. Only the fields you send change - but `permissions`, if sent, replaces the role's entire permission set.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'Role ID to update.',
          },
          display_name: {
            type: 'string',
            minLength: 3,
            // Same rule as create, and upstream applies it here too: the update rule is
            // ['string','min:3','max:180'], and a padded short name survives trimming as a
            // non-empty value, so min:3 runs and 422s (PUT /api/roles/2 {"display_name":
            // "   a"}, verified live - see trimmedMinLengthPattern in src/types.ts).
            //
            // The blank case is the exception, and the one place this is stricter than
            // upstream: '   ' trims to '', which Laravel treats as ABSENT, so every
            // non-implicit rule on it is skipped and BookStack blanks the role's name on a
            // 200 rather than erroring. The pattern refuses that too, for the reason
            // NONBLANK_PATTERN gives: silent destruction of a name is not an outcome worth
            // forwarding a call for.
            pattern: trimmedMinLengthPattern(3),
            maxLength: 180,
            description:
              'New display name. BookStack requires 3 to 180 characters, counted AFTER it trims the value - so "   a" is rejected as one character, not accepted as four.',
          },
          description: {
            type: 'string',
            maxLength: 180,
            description: 'New description.',
          },
          mfa_enforced: {
            type: 'boolean',
            description: 'Require MFA for users in this role.',
          },
          external_auth_id: {
            type: 'string',
            maxLength: 180,
            description: 'External ID for LDAP/SSO syncing.',
          },
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The role\'s complete new permission set, as an array of permission-name strings (e.g. ["content-export"]). This REPLACES the existing set rather than merging into it, so include every permission the role should keep; `[]` clears them all. Names BookStack does not recognise are dropped without an error.',
          },
        },
      },
      examples: [
        {
          description:
            "Set the role's permissions to exactly these two, dropping any it held before",
          input: { id: 3, permissions: ['content-export', 'restrictions-manage-own'] },
          expected_output:
            'The updated role, whose `permissions` is now exactly ["content-export", "restrictions-manage-own"]',
          use_case: 'Redefining what a role grants',
        },
      ],
      usage_patterns: [
        'To *add* a permission, read the role first (`bookstack_roles_read`) and send its current permissions plus the new one - sending only the new one silently revokes the rest.',
      ],
      related_tools: ['bookstack_roles_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No role has that id',
          recovery_suggestion: 'Confirm the id with bookstack_roles_list',
        },
        {
          code: 'VALIDATION_ERROR',
          description:
            'display_name shorter than 3 characters once trimmed, or a field over its 180 cap',
          recovery_suggestion:
            'Keep display_name between 3 and 180 characters, counting only what survives trimming',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema.
        const { id, ...validatedParams } = this.validator.validateParams<UpdateRoleRequest>(
          params,
          'roleUpdate'
        );
        this.logger.info('Updating role', {
          id,
          fields: Object.keys(validatedParams),
        });
        return await this.client.updateRole(id, validatedParams);
      },
    };
  }

  /**
   * Delete role tool
   */
  private createDeleteRoleTool(): MCPTool {
    return {
      name: 'bookstack_roles_delete',
      description:
        "Permanently delete a role. Users assigned to it simply lose it, keeping their other roles; BookStack's API offers no way to move them to another role as part of the deletion, so re-assign them first if they need a replacement. Roles do not go through the recycle bin and cannot be restored.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the role to delete.',
          },
        },
      },
      examples: [
        {
          description: 'Delete a role',
          input: { id: 3 },
          expected_output: '{ success: true, message: "Role 3 deleted successfully" }',
          use_case: 'Removing an access level that is no longer used',
        },
      ],
      usage_patterns: [
        'Deleting a role strips it from its users without replacement. To preserve their access, first list the affected users and update each one onto the replacement role, then delete.',
      ],
      related_tools: ['bookstack_roles_list', 'bookstack_users_update'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No role has that id',
          recovery_suggestion: 'Confirm the id with bookstack_roles_list',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting role', { id });
        await this.client.deleteRole(id);
        return { success: true, message: `Role ${id} deleted successfully` };
      },
    };
  }
}
