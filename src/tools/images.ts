import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';
import { resolveImage } from '../utils/imageResolver';

const UPLOAD_PORTAL_URL = process.env.BASE_URL ? `${process.env.BASE_URL.replace(/\/$/, '')}/upload` : null;

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
    return [
      this.createListImagesTool(),
      this.createCreateImageTool(),
      this.createReadImageTool(),
      this.createUpdateImageTool(),
      this.createDeleteImageTool(),
      this.createGetUploadPortalTool(),
    ];
  }

  /**
   * List images tool
   */
  private createListImagesTool(): MCPTool {
    return {
      name: 'bookstack_images_list',
      description: 'List all images in the gallery with pagination and filtering options',
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
            enum: ['name', 'created_at', 'updated_at'],
            default: 'created_at',
            description: 'Sort field',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by image name (partial match)',
              },
              type: {
                type: 'string',
                enum: ['gallery', 'drawio'],
                description: 'Filter by image type',
              },
              uploaded_to: {
                type: 'integer',
                description: 'Filter by page ID the image belongs to',
              },
            },
            description: 'Optional filters to apply',
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
      ],
      usage_patterns: [
        'Use before embedding images in content',
        'Filter by type to find specific image categories',
        'Search by name to find specific images',
      ],
      related_tools: ['bookstack_images_read', 'bookstack_pages_update'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: any) => {
        this.logger.debug('Listing images', params);
        const validatedParams = this.validator.validateParams<any>(params, 'imagesList');
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
      description: `Upload a new image to the gallery. Accepts base64 strings, data URIs (data:image/png;base64,...), or HTTP/HTTPS URLs (fetched server-side).${UPLOAD_PORTAL_URL ? ` IMPORTANT: If the image is too large to pass as base64 (typically >100 KB), instruct the user to upload it via the portal first: ${UPLOAD_PORTAL_URL} — they can drag & drop or paste (Ctrl+V) the image there and get a URL to use here.` : ''}`,
      inputSchema: {
        type: 'object',
        required: ['name', 'image'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
            description: 'Image title.',
          },
          image: {
            type: 'string',
            description: 'Image content as plain base64 string, data URI (data:image/png;base64,...), or HTTP/HTTPS URL. URLs are fetched server-side; only public URLs are allowed.',
          },
          type: {
            type: 'string',
            enum: ['gallery', 'drawio'],
            default: 'gallery',
            description: 'Type of image.',
          },
          uploaded_to: {
            type: 'integer',
            description: 'ID of the page this image is initially associated with.',
          },
        },
      },
      examples: [
        {
          description: 'Upload a screenshot',
          input: { name: 'Dashboard Screenshot', image: '<base64_content>', uploaded_to: 5 },
          expected_output: 'Image object with URL',
          use_case: 'Adding visuals to documentation',
        }
      ],
      usage_patterns: [
        'Upload images first, then use the returned URL to embed them in page HTML/Markdown',
      ],
      related_tools: ['bookstack_pages_update'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Missing image content',
          recovery_suggestion: 'Provide valid base64 string',
        }
      ],
      handler: async (params: any) => {
        this.logger.info('Creating image', { name: params.name, type: params.type });
        const validatedParams = this.validator.validateParams<any>(params, 'imageCreate');
        const preparedImage = await resolveImage(validatedParams.image, validatedParams.name);
        return await this.client.createImage(validatedParams, preparedImage);
      },
    };
  }

  /**
   * Read image tool
   */
  private createReadImageTool(): MCPTool {
    return {
      name: 'bookstack_images_read',
      description: 'Get details of a specific image, including its display URL and thumbnail URLs.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'The unique ID of the image.',
          },
        },
      },
      examples: [
        {
          description: 'Get image URL',
          input: { id: 10 },
          expected_output: 'Image object with url field',
          use_case: 'Retrieving image source for embedding',
        }
      ],
      usage_patterns: [
        'Use to check if an image exists and get its URL',
      ],
      related_tools: ['bookstack_images_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Image not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
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
      description: 'Update an image\'s details. Can be used to rename or replace the actual image file.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            description: 'ID of the image to update',
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            description: 'New title',
          },
          image: {
            type: 'string',
            description: 'New image content as plain base64 string, data URI (data:image/png;base64,...), or HTTP/HTTPS URL. Replaces existing image.',
          },
          uploaded_to: {
            type: 'integer',
            description: 'New page ID association',
          },
        },
      },
      examples: [
        {
          description: 'Update image title',
          input: { id: 10, name: 'New Title' },
          expected_output: 'Updated image object',
          use_case: 'Correcting metadata',
        }
      ],
      usage_patterns: [
        'Replacing the image content updates it everywhere it is used (since URL stays same usually, but verify cache)',
      ],
      related_tools: ['bookstack_images_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Image not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.info('Updating image', { id, fields: Object.keys(params).filter(k => k !== 'id') });
        const { id: _, ...updateParams } = params;
        const validatedParams = this.validator.validateParams<any>(updateParams, 'imageUpdate');
        if (validatedParams.image) {
          const preparedImage = await resolveImage(validatedParams.image, `image-${id}`);
          return await this.client.updateImage(id, validatedParams, preparedImage);
        }
        return await this.client.updateImage(id, validatedParams);
      },
    };
  }

  /**
   * Delete image tool
   */
  private createDeleteImageTool(): MCPTool {
    return {
      name: 'bookstack_images_delete',
      description: 'Permanently delete an image from the gallery. Broken images will appear in pages where this was used.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
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
        }
      ],
      usage_patterns: [
        'Ensure the image is not used in important pages before deleting',
      ],
      related_tools: ['bookstack_images_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Image not found',
          recovery_suggestion: 'Verify ID',
        }
      ],
      handler: async (params: any) => {
        const id = this.validator.validateId(params.id);
        this.logger.warn('Deleting image', { id });
        await this.client.deleteImage(id);
        return { success: true, message: `Image ${id} deleted successfully` };
      },
    };
  }

  private createGetUploadPortalTool(): MCPTool {
    return {
      name: 'bookstack_images_get_upload_url',
      description: 'Returns the URL of the image upload portal. Use this when the user wants to upload a large image that cannot be passed as base64 inline. The portal supports drag & drop and Ctrl+V paste — the user uploads the image there and gets a temporary URL to use with bookstack_images_create.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async (_params: any) => {
        if (!UPLOAD_PORTAL_URL) {
          return {
            available: false,
            message: 'Upload portal is not configured. Set the BASE_URL environment variable to enable it.',
          };
        }
        return {
          available: true,
          upload_url: UPLOAD_PORTAL_URL,
          instructions: `Tell the user to open this URL in their browser: ${UPLOAD_PORTAL_URL}\n\nThey can drag & drop an image onto the page or paste it with Ctrl+V. The portal will show a temporary URL (valid for 10 minutes) that can be passed to bookstack_images_create as the "image" parameter.`,
        };
      },
    };
  }
}