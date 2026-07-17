import type { BookStackClient } from '../api/client';
import {
  type AttachmentsListParams,
  type CreateAttachmentParams,
  type MCPTool,
  type UpdateAttachmentParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_attachments_update` request: what to update, plus the changes. */
type UpdateAttachmentRequest = UpdateAttachmentParams & IdRequest;

/**
 * Attachment management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete attachment lifecycle management:
 * - List, create, read, update, and delete attachments
 */
export class AttachmentTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all attachment tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListAttachmentsTool(),
      this.createCreateAttachmentTool(),
      this.createReadAttachmentTool(),
      this.createUpdateAttachmentTool(),
      this.createDeleteAttachmentTool(),
    ]);
  }

  /**
   * List attachments tool
   */
  private createListAttachmentsTool(): MCPTool {
    return {
      name: 'bookstack_attachments_list',
      description:
        'List all attachments visible to the authenticated user with pagination and filtering options. Each result carries an `external` flag: false for an uploaded file, true when the attachment is only a link.',
      category: 'attachments',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of attachments to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of attachments to skip',
          },
          sort: {
            type: 'string',
            enum: [
              'name',
              'extension',
              'uploaded_to',
              'created_at',
              'updated_at',
              '-name',
              '-extension',
              '-uploaded_to',
              '-created_at',
              '-updated_at',
            ],
            default: 'name',
            description: 'Sort field. Prefix with "-" to sort descending.',
          },
          filter: {
            type: 'object',
            properties: {
              uploaded_to: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by the ID of the page the attachment belongs to',
              },
              name: {
                type: 'string',
                description:
                  'Filter by attachment name. This is an exact, whole-value match, not a substring search - use bookstack_search to find content by partial name.',
              },
              extension: {
                type: 'string',
                description:
                  "Filter by file extension, matched exactly and without a leading dot (e.g. 'pdf', 'docx', 'txt'). Link attachments have an empty extension.",
              },
            },
            description: 'Optional filters to apply. All filters match exactly.',
          },
        },
      },
      examples: [
        {
          description: 'List first 10 attachments',
          input: { count: 10 },
          expected_output: 'Array of attachment objects with metadata',
          use_case: 'Getting overview of available files',
        },
        {
          description: 'Find PDF attachments',
          input: { filter: { extension: 'pdf' } },
          expected_output: 'Attachments with PDF extension',
          use_case: 'Finding specific document types',
        },
      ],
      usage_patterns: [
        'Use before downloading specific attachments',
        'Filter by uploaded_to to see the files belonging to one page',
        'Filter by extension to find file types',
      ],
      related_tools: ['bookstack_attachments_read', 'bookstack_pages_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<AttachmentsListParams>(
          params,
          'attachmentsList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing attachments', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listAttachments(validatedParams);
      },
    };
  }

  /**
   * Create attachment tool
   */
  private createCreateAttachmentTool(): MCPTool {
    return {
      name: 'bookstack_attachments_create',
      description:
        'Create a new attachment on a page, either by uploading a file or by linking to an external URL. Provide EXACTLY ONE of file, file_path or link: sending a link alongside either upload form is rejected, because BookStack would store the upload, delete it, and keep only the link.',
      inputSchema: {
        type: 'object',
        required: ['uploaded_to', 'name'],
        properties: {
          uploaded_to: {
            type: 'integer',
            minimum: 1,
            description:
              'ID of the page to attach the file to. Must be an existing page - chapters and books cannot hold attachments.',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'Name/Title of the attachment.',
          },
          file: {
            type: 'string',
            description:
              'Base64 encoded file content, at most 50000 KB. Mutually exclusive with file_path and link.',
          },
          file_path: {
            type: 'string',
            description:
              'Path to a file on the server to upload instead of inlining base64. Mutually exclusive with file and link. Allowed when the server runs over the stdio transport; over HTTP it requires the operator to set BOOKSTACK_UPLOAD_ROOT and the path must resolve inside it.',
          },
          link: {
            type: 'string',
            format: 'uri',
            minLength: 1,
            maxLength: 2000,
            description:
              'External URL, creating a link attachment rather than an uploaded file. Mutually exclusive with file and file_path. BookStack rejects unsafe schemes such as javascript:.',
          },
        },
        // The exactly-one rule, stated in the schema rather than only in prose: each
        // branch requires one source and forbids the other two, so no combination of
        // two can satisfy exactly one branch.
        oneOf: [
          {
            title: 'Upload inline base64 content',
            required: ['file'],
            not: { anyOf: [{ required: ['file_path'] }, { required: ['link'] }] },
          },
          {
            title: 'Upload a file already on the server',
            required: ['file_path'],
            not: { anyOf: [{ required: ['file'] }, { required: ['link'] }] },
          },
          {
            title: 'Point at an external URL',
            required: ['link'],
            not: { anyOf: [{ required: ['file'] }, { required: ['file_path'] }] },
          },
        ],
      },
      examples: [
        {
          description: 'Attach a PDF file',
          input: { uploaded_to: 12, name: 'Manual.pdf', file: '<base64_content>' },
          expected_output: 'Attachment object',
          use_case: 'Adding supplementary files',
        },
        {
          description: 'Attach a file from the server',
          input: { uploaded_to: 12, name: 'Manual.pdf', file_path: '/srv/uploads/manual.pdf' },
          expected_output: 'Attachment object',
          use_case: 'Uploading a large file without base64 overhead',
        },
        {
          description: 'Attach a link',
          input: { uploaded_to: 12, name: 'External Resource', link: 'https://example.com' },
          expected_output: 'Attachment object',
          use_case: 'Linking to external references',
        },
      ],
      usage_patterns: [
        'Use attachments for non-image files or external links that should be associated with a page',
        'Prefer file_path over base64 for large files, where the transport allows it',
      ],
      related_tools: ['bookstack_pages_read'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Missing file/file_path/link or page ID, or more than one content source supplied (any pair of file, file_path and link). The error names the two that collided.',
          recovery_suggestion:
            'Provide exactly one of file, file_path or link, and a valid uploaded_to ID. To replace an uploaded file with a link, create the link attachment and delete the old one - they cannot be combined in a single call.',
        },
        {
          code: 'VALIDATION_ERROR',
          description: 'file_path refused, or resolves outside BOOKSTACK_UPLOAD_ROOT',
          recovery_suggestion:
            'Send the content as base64, or ask the operator to set BOOKSTACK_UPLOAD_ROOT to a directory holding the file',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateAttachmentParams>(
          params,
          'attachmentCreate'
        );
        // The name's size, not the name. See the same line in src/tools/books.ts.
        this.logger.info('Creating attachment', {
          name_length: validatedParams.name.length,
          uploaded_to: validatedParams.uploaded_to,
          source: validatedParams.file_path
            ? 'file_path'
            : validatedParams.link
              ? 'link'
              : 'base64',
        });
        return await this.client.createAttachment(validatedParams);
      },
    };
  }

  /**
   * Read attachment tool
   */
  private createReadAttachmentTool(): MCPTool {
    return {
      name: 'bookstack_attachments_read',
      description:
        'Get details and content of a specific attachment. The content is returned on the `content` property: base64 encoded file data for an uploaded file, or the target URL for a link attachment (`external: true`). `links.html` and `links.markdown` hold ready-made markup pointing at the attachment.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the attachment.',
          },
        },
      },
      examples: [
        {
          description: 'Get attachment info and content',
          input: { id: 42 },
          expected_output: 'Attachment object with content and links properties',
          use_case: 'Reading the file content, or resolving where a link attachment points',
        },
      ],
      usage_patterns: [
        'Use to fetch the file content itself: it arrives base64 encoded on `content`, so no separate download call is needed',
        'Check `external` first: true means `content` is a URL, false means it is base64 file data',
      ],
      related_tools: ['bookstack_attachments_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Attachment not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading attachment', { id });
        return await this.client.getAttachment(id);
      },
    };
  }

  /**
   * Update attachment tool
   */
  private createUpdateAttachmentTool(): MCPTool {
    return {
      name: 'bookstack_attachments_update',
      description:
        "Update an attachment's details. Can be used to rename, move it to another page, or replace the content. Sending none of file/file_path/link is fine - that is a metadata-only change - but at most ONE of them may be sent, since a link supplied alongside an upload would discard that upload. Note that replacing the content without also passing `name` renames the attachment to the uploaded file's filename.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the attachment to update',
          },
          uploaded_to: {
            type: 'integer',
            minimum: 1,
            description:
              'New page ID to associate with (Move attachment). Must be an existing page.',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description:
              'New name. Pass this alongside file/file_path to keep a chosen name when replacing content.',
          },
          file: {
            type: 'string',
            description:
              'New Base64 encoded file content (Replaces existing file), at most 50000 KB. Mutually exclusive with file_path and link.',
          },
          file_path: {
            type: 'string',
            description:
              'Path to a file on the server to upload instead of inlining base64. Mutually exclusive with file and link. Allowed when the server runs over the stdio transport; over HTTP it requires the operator to set BOOKSTACK_UPLOAD_ROOT and the path must resolve inside it.',
          },
          link: {
            type: 'string',
            format: 'uri',
            minLength: 1,
            maxLength: 2000,
            description:
              'New external URL, converting the attachment to a link. Mutually exclusive with file and file_path. BookStack rejects unsafe schemes such as javascript:.',
          },
        },
        // At most one content source: unlike create, none at all is valid here, so this
        // states the three pairwise exclusions instead of requiring a branch to match.
        allOf: [
          { not: { required: ['file', 'file_path'] } },
          { not: { required: ['file', 'link'] } },
          { not: { required: ['file_path', 'link'] } },
        ],
      },
      examples: [
        {
          description: 'Rename attachment',
          input: { id: 42, name: 'Updated Manual.pdf' },
          expected_output: 'Updated attachment object',
          use_case: 'Correcting filenames',
        },
        {
          description: 'Replace file content from a file on the server, keeping the name',
          input: { id: 42, name: 'Updated Manual.pdf', file_path: '/srv/uploads/manual-v2.pdf' },
          expected_output: 'Updated attachment object',
          use_case: 'Swapping in a new revision without base64 overhead',
        },
      ],
      usage_patterns: [
        'Be careful when updating file content, it permanently replaces the old file',
        "Pass `name` whenever you replace the content, otherwise the attachment takes the uploaded file's filename",
        'To turn an uploaded file into a link, send `link` on its own: BookStack deletes the stored file and the attachment becomes external. Do not send a replacement file at the same time - that upload would be stored and then discarded.',
      ],
      related_tools: ['bookstack_attachments_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Attachment not found',
          recovery_suggestion: 'Verify ID',
        },
        {
          code: 'VALIDATION_ERROR',
          description:
            'More than one content source supplied (any pair of file, file_path and link). The error names the two that collided.',
          recovery_suggestion:
            'Send at most one of file, file_path or link; omit all three to change only name or uploaded_to',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema - the
        // at-most-one-source rule included.
        const { id, ...updateParams } = this.validator.validateParams<UpdateAttachmentRequest>(
          params,
          'attachmentUpdate'
        );
        this.logger.info('Updating attachment', {
          id,
          fields: Object.keys(updateParams),
          source: updateParams.file_path ? 'file_path' : 'base64',
        });
        return await this.client.updateAttachment(id, updateParams);
      },
    };
  }

  /**
   * Delete attachment tool
   */
  private createDeleteAttachmentTool(): MCPTool {
    return {
      name: 'bookstack_attachments_delete',
      description: 'Permanently delete an attachment. This action cannot be undone.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the attachment to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete an attachment',
          input: { id: 42 },
          expected_output: 'Success message',
          use_case: 'Removing obsolete files',
        },
      ],
      usage_patterns: ['Confirm ID before deleting as this is permanent'],
      related_tools: ['bookstack_attachments_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Attachment not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting attachment', { id });
        await this.client.deleteAttachment(id);
        return { success: true, message: `Attachment ${id} deleted successfully` };
      },
    };
  }
}
