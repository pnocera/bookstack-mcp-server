import type { BookStackClient } from '../api/client';
import { type MCPTool, type UpdateContentPermissionsParams, withClosedSchemas } from '../types';
import type { Logger } from '../utils/logger';
import type { ContentPermissionsRequest, ValidationHandler } from '../validation/validator';

/**
 * The whole `bookstack_permissions_update` request: which item, plus the overrides.
 *
 * `content_type`/`content_id` address the item and are stripped before the body is sent;
 * they were previously cast rather than validated, which is why an invalid content_type
 * could reach the URL.
 */
type UpdateContentPermissionsRequest = UpdateContentPermissionsParams & ContentPermissionsRequest;

/**
 * Permission management tools for BookStack MCP Server
 *
 * Provides 2 tools for content permission management:
 * - Read and update content permissions
 */
export class PermissionTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all permission tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createReadPermissionsTool(),
      this.createUpdatePermissionsTool(),
    ]);
  }

  /**
   * Read permissions tool
   */
  private createReadPermissionsTool(): MCPTool {
    return {
      name: 'bookstack_permissions_read',
      description:
        'Read the content-level permission overrides configured on one book, chapter, page or shelf. Returns { owner, role_permissions[], fallback_permissions }. These are only the overrides set on this item: they are not the fully evaluated permissions for a role, and they do not include anything inherited from a parent item. An empty role_permissions with fallback_permissions.inheriting = true means "no overrides here", NOT "nobody has access".',
      category: 'permissions',
      inputSchema: {
        type: 'object',
        required: ['content_type', 'content_id'],
        properties: {
          content_type: {
            type: 'string',
            enum: ['book', 'chapter', 'page', 'bookshelf'],
            description: 'The type of entity.',
          },
          content_id: {
            type: 'integer',
            minimum: 1,
            description: 'The ID of the entity.',
          },
        },
      },
      examples: [
        {
          description: 'Check book permissions',
          input: { content_type: 'book', content_id: 5 },
          expected_output:
            '{ owner: { id, name, slug }, role_permissions: [{ role_id, view, create, update, delete, role: { id, display_name } }], fallback_permissions: { inheriting, view, create, update, delete } }',
          use_case: 'Verifying access control',
        },
      ],
      usage_patterns: [
        'Use to debug why a user cannot see a page',
        'Read before updating: an update that sends role_permissions replaces the whole set, so start from what is already there',
        'The four fallback_permissions flags are null whenever inheriting is true',
      ],
      related_tools: ['bookstack_permissions_update'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No item of that type with that ID, or it is not visible to this token',
          recovery_suggestion: 'Check content_type and content_id',
        },
      ],
      handler: async (params: unknown) => {
        const { content_type, content_id } =
          this.validator.validateParams<ContentPermissionsRequest>(params, 'contentPermissions');
        this.logger.debug('Reading permissions', { content_type, content_id });
        return await this.client.getContentPermissions(content_type, content_id);
      },
    };
  }

  /**
   * Update permissions tool
   */
  private createUpdatePermissionsTool(): MCPTool {
    return {
      name: 'bookstack_permissions_update',
      description:
        "Set the content-level permission overrides on one book, chapter, page or shelf, overriding default role-based access, and optionally reassign its owner. Each of owner_id, role_permissions and fallback_permissions is updated only if you send it: omit one to leave that category untouched. Sending role_permissions REPLACES the whole set (so sending [] removes every role override). Returns the item's permissions as they now stand.",
      category: 'permissions',
      inputSchema: {
        type: 'object',
        required: ['content_type', 'content_id'],
        properties: {
          content_type: {
            type: 'string',
            enum: ['book', 'chapter', 'page', 'bookshelf'],
            description: 'Type of entity.',
          },
          content_id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the entity.',
          },
          owner_id: {
            type: 'integer',
            minimum: 1,
            description:
              'The ID of the user to transfer ownership of this item to. Note the asymmetry with bookstack_permissions_read, which reports the owner as an `owner` object: ownership is READ as `owner` but SET as `owner_id`. WARNING: an unknown user ID is silently ignored - BookStack returns a success response with the owner left unchanged and no validation error, unlike an unknown role_id which is rejected. Confirm the ID with bookstack_users_list first, and check `owner` on the response to see whether it actually took.',
          },
          fallback_permissions: {
            type: 'object',
            required: ['inheriting'],
            properties: {
              inheriting: {
                type: 'boolean',
                description:
                  'Whether to inherit permissions from the parent item. When true, send nothing else in this object. When false, all four of view/create/update/delete become REQUIRED - they define what everyone without a matching role_permissions entry may do.',
              },
              view: {
                type: 'boolean',
                description:
                  'Required when inheriting is false. Whether non-granted roles can view.',
              },
              create: {
                type: 'boolean',
                description:
                  'Required when inheriting is false. Whether non-granted roles can create.',
              },
              update: {
                type: 'boolean',
                description:
                  'Required when inheriting is false. Whether non-granted roles can update.',
              },
              delete: {
                type: 'boolean',
                description:
                  'Required when inheriting is false. Whether non-granted roles can delete.',
              },
            },
            description:
              'The default permissions applied to anyone not covered by role_permissions. Either { inheriting: true } alone, or inheriting: false together with all four action flags.',
            // BookStack's `required_if:fallback_permissions.inheriting,false` rule, stated
            // in the schema rather than only in prose and in the zod union that enforces
            // it. A client generating a call from this contract previously saw four
            // independently-optional flags and only `inheriting` required, so
            // `{ inheriting: false }` read as a legal call that the server then refused.
            // Each branch pins `inheriting` to one value and states the property set that
            // value demands, exactly as the attachment and image tools state their
            // exactly-one content rule.
            oneOf: [
              {
                title: 'Inherit from the parent item',
                required: ['inheriting'],
                properties: { inheriting: { const: true } },
                // Sending a flag here is rejected rather than ignored, and deliberately so:
                // BookStack itself answers 200 and nulls all four (verified live on
                // v26.05.2 - `{inheriting: true, view: true}` came back with
                // `view: null`), so an accepted `view: true` would mean the opposite of
                // what it says. This server refuses it instead, and the zod union does the
                // same - which is what this branch has to state, because a schema that
                // advertised it as legal would be advertising a call the server refuses.
                not: {
                  anyOf: [
                    { required: ['view'] },
                    { required: ['create'] },
                    { required: ['update'] },
                    { required: ['delete'] },
                  ],
                },
              },
              {
                title: 'Override the parent with explicit fallback flags',
                required: ['inheriting', 'view', 'create', 'update', 'delete'],
                properties: { inheriting: { const: false } },
              },
            ],
          },
          role_permissions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['role_id', 'view', 'create', 'update', 'delete'],
              properties: {
                role_id: {
                  type: 'integer',
                  minimum: 1,
                  description: 'Role to grant access to.',
                },
                view: { type: 'boolean' },
                create: { type: 'boolean' },
                update: { type: 'boolean' },
                delete: { type: 'boolean' },
              },
            },
            description:
              'Per-role access grants. Every entry must state role_id plus all four action flags. Sending this REPLACES every existing role override on the item, so send the complete set you want to end up with - read the current ones first if you only mean to add or remove one. Sending [] clears them all; omitting the property entirely leaves them untouched. Permissions are role-based only; there is no per-user grant. An unknown role_id is rejected with a 422.',
          },
        },
      },
      examples: [
        {
          description: 'Restrict a book to a single role',
          input: {
            content_type: 'book',
            content_id: 5,
            fallback_permissions: {
              inheriting: false,
              view: false,
              create: false,
              update: false,
              delete: false,
            },
            role_permissions: [
              { role_id: 3, view: true, create: false, update: false, delete: false },
            ],
          },
          expected_output: 'Updated permissions',
          use_case: 'Locking down sensitive content',
        },
        {
          description: 'Hand an item back to inheriting from its parent',
          input: {
            content_type: 'book',
            content_id: 5,
            fallback_permissions: { inheriting: true },
          },
          expected_output: 'Updated permissions with null fallback values',
          use_case: 'Undoing a custom permission setup',
        },
        {
          description: 'Transfer ownership of a book without touching its permissions',
          input: { content_type: 'book', content_id: 5, owner_id: 12 },
          expected_output:
            'Updated permissions whose owner is now { id: 12, ... } - or the UNCHANGED previous owner if user 12 does not exist',
          use_case: 'Reassigning content when someone leaves the team',
        },
      ],
      usage_patterns: [
        'To lock content down, set fallback_permissions to inheriting:false with all four flags false, then list the roles that keep access in role_permissions.',
        'Sending inheriting:false without all four of view/create/update/delete is rejected - BookStack requires the complete set.',
        'To add or remove a single role, read the current role_permissions first and send the full amended list back: this tool replaces rather than merges.',
        'owner_id is the only way to reassign ownership, and it fails silently: always confirm the user id first, then check `owner` on the response rather than trusting the success status.',
      ],
      related_tools: ['bookstack_permissions_read', 'bookstack_audit_log_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'No item of that type with that ID, or it is not visible to this token',
          recovery_suggestion: 'Check content_type and content_id',
        },
        {
          code: 'VALIDATION_ERROR',
          description:
            'BookStack rejected the payload with a 422: inheriting was false without all four action flags, a role_permissions entry was incomplete, or a role_id does not exist',
          recovery_suggestion:
            'Send inheriting:false only together with view/create/update/delete, give every role_permissions entry all four flags, and confirm role ids with bookstack_roles_list',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: the addressing fields are part of the
        // request, so removing them beforehand left the strict schema unable to see them.
        const { content_type, content_id, ...updateParams } =
          this.validator.validateParams<UpdateContentPermissionsRequest>(
            params,
            'contentPermissionsUpdate'
          );
        this.logger.info('Updating permissions', { content_type, content_id });
        return await this.client.updateContentPermissions(content_type, content_id, updateParams);
      },
    };
  }
}
