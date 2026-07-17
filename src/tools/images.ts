import type { BookStackClient } from '../api/client';
import {
  type CreateImageParams,
  type ImageGalleryListParams,
  type MCPTool,
  type UpdateImageParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_images_update` request: the image to update, plus the changes. */
type UpdateImageRequest = UpdateImageParams & IdRequest;

/**
 * Image management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete image lifecycle management:
 * - List, create, read, update, and delete images
 */
export class ImageTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all image tools
   */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListImagesTool(),
      this.createCreateImageTool(),
      this.createReadImageTool(),
      this.createUpdateImageTool(),
      this.createDeleteImageTool(),
    ]);
  }

  /**
   * List images tool
   */
  private createListImagesTool(): MCPTool {
    return {
      name: 'bookstack_images_list',
      description:
        'List images in the gallery, covering both page-content images and drawio diagrams. Only images uploaded to a page the authenticated user can see are returned.',
      category: 'images',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of images to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of images to skip',
          },
          sort: {
            type: 'string',
            enum: ['name', 'created_at', 'updated_at', '-name', '-created_at', '-updated_at'],
            default: 'name',
            description: 'Sort field. Prefix with "-" to sort descending.',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description:
                  'Filter by image name. This is an exact, whole-value match, not a substring search - use bookstack_search to find images by partial name.',
              },
              type: {
                type: 'string',
                enum: ['gallery', 'drawio'],
                description: 'Filter by image type',
              },
              uploaded_to: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by the ID of the page the image was uploaded to',
              },
            },
            description: 'Optional filters to apply. All filters match exactly.',
          },
        },
      },
      examples: [
        {
          description: 'List first 10 images',
          input: { count: 10 },
          expected_output: 'Array of image objects with URLs and metadata',
          use_case: 'Getting overview of available images',
        },
        {
          description: 'Find gallery images only',
          input: { filter: { type: 'gallery' } },
          expected_output: 'Images from the gallery (not drawio diagrams)',
          use_case: 'Finding regular uploaded images',
        },
        {
          description: 'Find every image uploaded to one page',
          input: { filter: { uploaded_to: 5 } },
          expected_output: 'Images attached to page 5',
          use_case: 'Auditing the images a page depends on before editing it',
        },
      ],
      usage_patterns: [
        'Use before embedding images in content',
        'Filter by type to find specific image categories',
        'Filter by uploaded_to to find the images belonging to a given page',
      ],
      related_tools: ['bookstack_images_read', 'bookstack_pages_update'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<ImageGalleryListParams>(
          params,
          'imagesList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing images', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listImages(validatedParams);
      },
    };
  }

  /**
   * Create image tool
   */
  private createCreateImageTool(): MCPTool {
    return {
      name: 'bookstack_images_create',
      description:
        'Upload a new image to the gallery. These images can be used in pages. The image is sent to BookStack as a file upload, so supply the content as base64 via `image` or as a server-local path via `file_path`.',
      inputSchema: {
        type: 'object',
        required: ['uploaded_to'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 180,
            description:
              "Image title, at most 180 characters. Optional, exactly as it is upstream: omit it and BookStack names the image after the uploaded file's filename - which this server derives from file_path, or from the image's magic bytes when the content is inlined as base64.",
          },
          image: {
            type: 'string',
            description:
              'Base64 encoded image content. Supply this or file_path, not both. Must be a JPEG, PNG, GIF, WebP or AVIF, and at most 50000 KB.',
          },
          file_path: {
            type: 'string',
            description:
              'Path to a file on the server to upload instead of inlining base64. Allowed when the server runs over the stdio transport; over HTTP it requires the operator to set BOOKSTACK_UPLOAD_ROOT and the path must resolve inside it.',
          },
          type: {
            type: 'string',
            enum: ['gallery', 'drawio'],
            default: 'gallery',
            description:
              "Type of image. Use 'gallery' for ordinary page-content images; 'drawio' is only for a PNG with diagrams.net data embedded in it.",
          },
          uploaded_to: {
            type: 'integer',
            minimum: 1,
            description:
              'ID of the page this image is associated with. Required by BookStack, and must be an existing page.',
          },
        },
        // The exactly-one rule, stated in the schema rather than only in prose and the
        // refinement below it. Runtime validation has always rejected neither/both, but a
        // client generated from this contract could not see that: both properties simply
        // looked optional, so "omit them both" and "send them both" read as legal calls
        // that the server then refused. Each branch requires one source and forbids the
        // other, so no combination of two can satisfy exactly one branch. The attachment
        // tools state their three-way version of this the same way.
        oneOf: [
          {
            title: 'Upload inline base64 content',
            required: ['image'],
            not: { required: ['file_path'] },
          },
          {
            title: 'Upload a file already on the server',
            required: ['file_path'],
            not: { required: ['image'] },
          },
        ],
      },
      examples: [
        {
          description: 'Upload a screenshot',
          input: { name: 'Dashboard Screenshot', image: '<base64_content>', uploaded_to: 5 },
          expected_output: 'Image object with URL',
          use_case: 'Adding visuals to documentation',
        },
        {
          description: 'Upload from a file on the server',
          input: { name: 'Diagram.png', file_path: '/srv/uploads/diagram.png', uploaded_to: 5 },
          expected_output: 'Image object with URL',
          use_case: 'Uploading a large image without base64 overhead',
        },
        {
          description: 'Upload without naming it, taking the filename as the name',
          input: { file_path: '/srv/uploads/architecture.png', uploaded_to: 5 },
          expected_output: 'Image object whose name is "architecture.png"',
          use_case: 'Bulk-uploading files whose filenames are already meaningful',
        },
      ],
      usage_patterns: [
        'Upload images first, then use the returned URL to embed them in page HTML/Markdown',
        'Prefer file_path over base64 for large images, where the transport allows it',
        'Prefer short names. The uploaded filename is derived from `name`, and BookStack stores the gallery URL in a 191-character column, so a long name silently truncates the returned `url` mid-name (dropping the extension); that URL then serves the HTML app page rather than the image. The upload itself still succeeds and `path` keeps the full name. How long is too long depends on the length of the instance base URL.',
      ],
      related_tools: ['bookstack_pages_update'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Missing image content, or both image and file_path supplied',
          recovery_suggestion: 'Provide exactly one of image (base64) or file_path',
        },
        {
          code: 'VALIDATION_ERROR',
          description: 'file_path refused, or resolves outside BOOKSTACK_UPLOAD_ROOT',
          recovery_suggestion:
            'Send the content as base64, or ask the operator to set BOOKSTACK_UPLOAD_ROOT to a directory holding the file',
        },
        {
          code: 'NOT_FOUND',
          description:
            'uploaded_to names a page that does not exist or is not visible. Note this surfaces as a not-found error here, unlike the attachment tools which report a validation error for the same mistake.',
          recovery_suggestion:
            'Confirm the page ID with bookstack_pages_list or bookstack_search before uploading',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateImageParams>(
          params,
          'imageCreate'
        );
        // The name's size, not the name (it is optional here, so `undefined` means none was
        // given rather than an empty one). `type` and `source` are this codebase's own enum
        // labels. See the same line in src/tools/books.ts.
        this.logger.info('Creating image', {
          name_length: validatedParams.name?.length,
          type: validatedParams.type,
          source: validatedParams.file_path ? 'file_path' : 'base64',
        });
        return await this.client.createImage(validatedParams);
      },
    };
  }

  /**
   * Read image tool
   */
  private createReadImageTool(): MCPTool {
    return {
      name: 'bookstack_images_read',
      description:
        'Get details of a specific image: its `url`, the scaled variants under `thumbs`, and a `content` property holding ready-made HTML and Markdown for embedding it in a page. The image file data itself is not returned.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The unique ID of the image.',
          },
        },
      },
      examples: [
        {
          description: 'Get image URL',
          input: { id: 10 },
          expected_output: 'Image object with url, thumbs and content fields',
          use_case: 'Retrieving image source for embedding',
        },
      ],
      usage_patterns: [
        'Use to check if an image exists and get its URL',
        'Use the `content.html` / `content.markdown` values to embed the image the way BookStack itself would',
      ],
      related_tools: ['bookstack_images_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Image not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading image', { id });
        return await this.client.getImage(id);
      },
    };
  }

  /**
   * Update image tool
   */
  private createUpdateImageTool(): MCPTool {
    return {
      name: 'bookstack_images_update',
      description:
        "Update an image's details. Can be used to rename or replace the actual image file. BookStack accepts only `name` and the image content here - an image cannot be moved to another page after creation.",
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the image to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 180,
            description: 'New title. BookStack rejects anything longer than 180 characters.',
          },
          image: {
            type: 'string',
            description:
              'New Base64 encoded image content (Replaces existing image). Supply this or file_path, not both. Should be the same file type as the original image, and at most 50000 KB.',
          },
          file_path: {
            type: 'string',
            description:
              'Path to a file on the server to upload instead of inlining base64. Allowed when the server runs over the stdio transport; over HTTP it requires the operator to set BOOKSTACK_UPLOAD_ROOT and the path must resolve inside it.',
          },
        },
        // At most one content source: unlike create, sending neither is valid here - that
        // is a rename - so this states the single exclusion rather than requiring a
        // branch to match. Same form as bookstack_attachments_update.
        allOf: [{ not: { required: ['image', 'file_path'] } }],
      },
      examples: [
        {
          description: 'Update image title',
          input: { id: 10, name: 'New Title' },
          expected_output: 'Updated image object',
          use_case: 'Correcting metadata',
        },
        {
          description: 'Replace image content from a file on the server',
          input: { id: 10, file_path: '/srv/uploads/new-diagram.png' },
          expected_output: 'Updated image object',
          use_case: 'Swapping in new artwork without base64 overhead',
        },
      ],
      usage_patterns: [
        'Replacing the image content keeps the same URL, so every page already embedding it picks up the new content',
        'Replacing the content does not change the name; pass `name` as well to rename at the same time',
        'BookStack only accepts name and image here; use uploaded_to at creation time',
      ],
      related_tools: ['bookstack_images_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Image not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: `id` is part of the request, so pulling it
        // out beforehand would hide the rest of the object from the strict schema - the
        // image/file_path exclusion included.
        const { id, ...updateParams } = this.validator.validateParams<UpdateImageRequest>(
          params,
          'imageUpdate'
        );
        this.logger.info('Updating image', {
          id,
          fields: Object.keys(updateParams),
          source: updateParams.file_path ? 'file_path' : 'base64',
        });
        return await this.client.updateImage(id, updateParams);
      },
    };
  }

  /**
   * Delete image tool
   */
  private createDeleteImageTool(): MCPTool {
    return {
      name: 'bookstack_images_delete',
      description:
        'Permanently delete an image from the gallery. Broken images will appear in pages where this was used.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the image to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete an image',
          input: { id: 10 },
          expected_output: 'Success message',
          use_case: 'Cleaning up unused assets',
        },
      ],
      usage_patterns: ['Ensure the image is not used in important pages before deleting'],
      related_tools: ['bookstack_images_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Image not found',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting image', { id });
        await this.client.deleteImage(id);
        return { success: true, message: `Image ${id} deleted successfully` };
      },
    };
  }
}
