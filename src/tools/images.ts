import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

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
      description: 'Upload a new image to the gallery. These images can be used in pages.',
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
            description: 'Base64 encoded image content.',
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
            description: 'New Base64 encoded image content (Replaces existing image)',
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
}