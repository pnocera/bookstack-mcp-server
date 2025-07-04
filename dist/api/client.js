"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookStackClient = void 0;
const axios_1 = __importDefault(require("axios"));
const https_1 = require("https");
const rateLimit_1 = require("../utils/rateLimit");
/**
 * BookStack API Client
 *
 * Provides a comprehensive wrapper around the BookStack REST API
 * with built-in error handling, rate limiting, and retry logic.
 */
class BookStackClient {
    constructor(config, logger, errorHandler) {
        this.config = config;
        this.logger = logger;
        this.errorHandler = errorHandler;
        this.rateLimiter = new rateLimit_1.RateLimiter(config.rateLimit);
        // Create HTTP agent for connection pooling
        const httpsAgent = new https_1.Agent({
            keepAlive: true,
            maxSockets: 10,
            timeout: config.bookstack.timeout,
        });
        // Initialize Axios client
        this.client = axios_1.default.create({
            baseURL: config.bookstack.baseUrl,
            timeout: config.bookstack.timeout,
            httpsAgent,
            headers: {
                'Authorization': `Token ${config.bookstack.apiToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': `${config.server.name}/${config.server.version}`,
            },
        });
        this.setupInterceptors();
        this.logger.info('BookStack API client initialized', {
            baseUrl: config.bookstack.baseUrl,
            timeout: config.bookstack.timeout,
        });
    }
    /**
     * Setup request and response interceptors
     */
    setupInterceptors() {
        // Request interceptor for rate limiting and logging
        this.client.interceptors.request.use(async (config) => {
            // Apply rate limiting
            await this.rateLimiter.acquire();
            this.logger.debug('API request', {
                method: config.method?.toUpperCase(),
                url: config.url,
                params: config.params,
            });
            return config;
        }, (error) => {
            this.logger.error('Request interceptor error', error);
            return Promise.reject(error);
        });
        // Response interceptor for error handling and logging
        this.client.interceptors.response.use((response) => {
            this.logger.debug('API response', {
                status: response.status,
                url: response.config.url,
                dataLength: JSON.stringify(response.data).length,
            });
            return response;
        }, (error) => {
            this.logger.error('API error', {
                status: error.response?.status,
                url: error.config?.url,
                message: error.message,
                data: error.response?.data,
            });
            return Promise.reject(this.errorHandler.handleAxiosError(error));
        });
    }
    /**
     * Generic request method with retry logic
     */
    async request(config) {
        try {
            const response = await this.client.request(config);
            return response.data;
        }
        catch (error) {
            throw this.errorHandler.handleError(error);
        }
    }
    /**
     * Health check method
     */
    async healthCheck() {
        try {
            await this.getSystemInfo();
            return true;
        }
        catch (error) {
            this.logger.warn('Health check failed', error);
            return false;
        }
    }
    // Books API
    async listBooks(params) {
        return this.request({
            method: 'GET',
            url: '/books',
            params,
        });
    }
    async createBook(params) {
        return this.request({
            method: 'POST',
            url: '/books',
            data: params,
        });
    }
    async getBook(id) {
        return this.request({
            method: 'GET',
            url: `/books/${id}`,
        });
    }
    async updateBook(id, params) {
        return this.request({
            method: 'PUT',
            url: `/books/${id}`,
            data: params,
        });
    }
    async deleteBook(id) {
        await this.request({
            method: 'DELETE',
            url: `/books/${id}`,
        });
    }
    async exportBook(id, format) {
        return this.request({
            method: 'GET',
            url: `/books/${id}/export/${format}`,
        });
    }
    // Pages API
    async listPages(params) {
        return this.request({
            method: 'GET',
            url: '/pages',
            params,
        });
    }
    async createPage(params) {
        return this.request({
            method: 'POST',
            url: '/pages',
            data: params,
        });
    }
    async getPage(id) {
        return this.request({
            method: 'GET',
            url: `/pages/${id}`,
        });
    }
    async updatePage(id, params) {
        return this.request({
            method: 'PUT',
            url: `/pages/${id}`,
            data: params,
        });
    }
    async deletePage(id) {
        await this.request({
            method: 'DELETE',
            url: `/pages/${id}`,
        });
    }
    async exportPage(id, format) {
        return this.request({
            method: 'GET',
            url: `/pages/${id}/export/${format}`,
        });
    }
    // Chapters API
    async listChapters(params) {
        return this.request({
            method: 'GET',
            url: '/chapters',
            params,
        });
    }
    async createChapter(params) {
        return this.request({
            method: 'POST',
            url: '/chapters',
            data: params,
        });
    }
    async getChapter(id) {
        return this.request({
            method: 'GET',
            url: `/chapters/${id}`,
        });
    }
    async updateChapter(id, params) {
        return this.request({
            method: 'PUT',
            url: `/chapters/${id}`,
            data: params,
        });
    }
    async deleteChapter(id) {
        await this.request({
            method: 'DELETE',
            url: `/chapters/${id}`,
        });
    }
    async exportChapter(id, format) {
        return this.request({
            method: 'GET',
            url: `/chapters/${id}/export/${format}`,
        });
    }
    // Shelves API
    async listShelves(params) {
        return this.request({
            method: 'GET',
            url: '/shelves',
            params,
        });
    }
    async createShelf(params) {
        return this.request({
            method: 'POST',
            url: '/shelves',
            data: params,
        });
    }
    async getShelf(id) {
        return this.request({
            method: 'GET',
            url: `/shelves/${id}`,
        });
    }
    async updateShelf(id, params) {
        return this.request({
            method: 'PUT',
            url: `/shelves/${id}`,
            data: params,
        });
    }
    async deleteShelf(id) {
        await this.request({
            method: 'DELETE',
            url: `/shelves/${id}`,
        });
    }
    // Users API
    async listUsers(params) {
        return this.request({
            method: 'GET',
            url: '/users',
            params,
        });
    }
    async createUser(params) {
        return this.request({
            method: 'POST',
            url: '/users',
            data: params,
        });
    }
    async getUser(id) {
        return this.request({
            method: 'GET',
            url: `/users/${id}`,
        });
    }
    async updateUser(id, params) {
        return this.request({
            method: 'PUT',
            url: `/users/${id}`,
            data: params,
        });
    }
    async deleteUser(id, migrateOwnershipId) {
        const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
        await this.request({
            method: 'DELETE',
            url: `/users/${id}`,
            data,
        });
    }
    // Roles API
    async listRoles(params) {
        return this.request({
            method: 'GET',
            url: '/roles',
            params,
        });
    }
    async createRole(params) {
        return this.request({
            method: 'POST',
            url: '/roles',
            data: params,
        });
    }
    async getRole(id) {
        return this.request({
            method: 'GET',
            url: `/roles/${id}`,
        });
    }
    async updateRole(id, params) {
        return this.request({
            method: 'PUT',
            url: `/roles/${id}`,
            data: params,
        });
    }
    async deleteRole(id, migrateOwnershipId) {
        const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
        await this.request({
            method: 'DELETE',
            url: `/roles/${id}`,
            data,
        });
    }
    // Attachments API
    async listAttachments(params) {
        return this.request({
            method: 'GET',
            url: '/attachments',
            params,
        });
    }
    async createAttachment(params) {
        return this.request({
            method: 'POST',
            url: '/attachments',
            data: params,
        });
    }
    async getAttachment(id) {
        return this.request({
            method: 'GET',
            url: `/attachments/${id}`,
        });
    }
    async updateAttachment(id, params) {
        return this.request({
            method: 'PUT',
            url: `/attachments/${id}`,
            data: params,
        });
    }
    async deleteAttachment(id) {
        await this.request({
            method: 'DELETE',
            url: `/attachments/${id}`,
        });
    }
    // Images API
    async listImages(params) {
        return this.request({
            method: 'GET',
            url: '/image-gallery',
            params,
        });
    }
    async createImage(params) {
        return this.request({
            method: 'POST',
            url: '/image-gallery',
            data: params,
        });
    }
    async getImage(id) {
        return this.request({
            method: 'GET',
            url: `/image-gallery/${id}`,
        });
    }
    async updateImage(id, params) {
        return this.request({
            method: 'PUT',
            url: `/image-gallery/${id}`,
            data: params,
        });
    }
    async deleteImage(id) {
        await this.request({
            method: 'DELETE',
            url: `/image-gallery/${id}`,
        });
    }
    // Search API
    async search(params) {
        return this.request({
            method: 'GET',
            url: '/search',
            params,
        });
    }
    // Recycle Bin API
    async listRecycleBin(params) {
        return this.request({
            method: 'GET',
            url: '/recycle-bin',
            params,
        });
    }
    async restoreFromRecycleBin(deletionId) {
        await this.request({
            method: 'PUT',
            url: `/recycle-bin/${deletionId}`,
        });
    }
    async permanentlyDelete(deletionId) {
        await this.request({
            method: 'DELETE',
            url: `/recycle-bin/${deletionId}`,
        });
    }
    // Content Permissions API
    async getContentPermissions(contentType, contentId) {
        return this.request({
            method: 'GET',
            url: `/content-permissions/${contentType}/${contentId}`,
        });
    }
    async updateContentPermissions(contentType, contentId, params) {
        return this.request({
            method: 'PUT',
            url: `/content-permissions/${contentType}/${contentId}`,
            data: params,
        });
    }
    // Audit Log API
    async listAuditLog(params) {
        return this.request({
            method: 'GET',
            url: '/audit-log',
            params,
        });
    }
    // System API
    async getSystemInfo() {
        return this.request({
            method: 'GET',
            url: '/system',
        });
    }
}
exports.BookStackClient = BookStackClient;
exports.default = BookStackClient;
//# sourceMappingURL=client.js.map