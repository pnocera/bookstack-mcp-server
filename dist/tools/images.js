"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImageTools = void 0;
/**
 * Image management tools for BookStack MCP Server
 *
 * Provides 5 tools for complete image lifecycle management:
 * - List, create, read, update, and delete images
 */
class ImageTools {
    constructor(client, validator, logger) {
        this.client = client;
        this.validator = validator;
        this.logger = logger;
    }
    /**
     * Get all image tools
     */
    getTools() {
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
    createListImagesTool() {
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
            handler: async (params) => {
                this.logger.debug('Listing images', params);
                const validatedParams = this.validator.validateParams(params, 'imagesList');
                return await this.client.listImages(validatedParams);
            },
        };
    }
    /**
     * Create image tool
     */
    createCreateImageTool() {
        return {
            name: 'bookstack_images_create',
            description: 'Create a new image by uploading an image file to the gallery',
            inputSchema: {
                type: 'object',
                required: ['name', 'image'],
                properties: {
                    name: {
                        type: 'string',
                        maxLength: 255,
                        description: 'Image name/title (required)',
                    },
                    image: {
                        type: 'string',
                        description: 'Base64 encoded image content (required)',
                    },
                    type: {
                        type: 'string',
                        enum: ['gallery', 'drawio'],
                        default: 'gallery',
                        description: 'Image type',
                    },
                    uploaded_to: {
                        type: 'integer',
                        description: 'Page ID to associate the image with',
                    },
                },
            },
            handler: async (params) => {
                this.logger.info('Creating image', { name: params.name, type: params.type });
                const validatedParams = this.validator.validateParams(params, 'imageCreate');
                return await this.client.createImage(validatedParams);
            },
        };
    }
    /**
     * Read image tool
     */
    createReadImageTool() {
        return {
            name: 'bookstack_images_read',
            description: 'Get details of a specific image including URLs and metadata',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Image ID to retrieve',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.debug('Reading image', { id });
                return await this.client.getImage(id);
            },
        };
    }
    /**
     * Update image tool
     */
    createUpdateImageTool() {
        return {
            name: 'bookstack_images_update',
            description: 'Update an image\'s details such as name or replace the image content',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Image ID to update',
                    },
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 255,
                        description: 'New image name/title',
                    },
                    image: {
                        type: 'string',
                        description: 'New Base64 encoded image content to replace existing image',
                    },
                    uploaded_to: {
                        type: 'integer',
                        description: 'Move image to different page association',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.info('Updating image', { id, fields: Object.keys(params).filter(k => k !== 'id') });
                const { id: _, ...updateParams } = params;
                const validatedParams = this.validator.validateParams(updateParams, 'imageUpdate');
                return await this.client.updateImage(id, validatedParams);
            },
        };
    }
    /**
     * Delete image tool
     */
    createDeleteImageTool() {
        return {
            name: 'bookstack_images_delete',
            description: 'Delete an image permanently from the gallery (this action cannot be undone)',
            inputSchema: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: {
                        type: 'integer',
                        description: 'Image ID to delete',
                    },
                },
            },
            handler: async (params) => {
                const id = this.validator.validateId(params.id);
                this.logger.warn('Deleting image', { id });
                await this.client.deleteImage(id);
                return { success: true, message: `Image ${id} deleted successfully` };
            },
        };
    }
}
exports.ImageTools = ImageTools;
//# sourceMappingURL=images.js.map