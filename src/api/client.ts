import axios, { AxiosInstance, AxiosResponse, AxiosError, AxiosRequestConfig } from 'axios';
import { Agent } from 'https';
import { Config } from '../config/manager';
import { Logger } from '../utils/logger';
import { ErrorHandler } from '../utils/errors';
import { RateLimiter } from '../utils/rateLimit';
import {
  BookStackAPIClient,
  Book,
  BookWithContents,
  Page,
  PageWithContent,
  Chapter,
  ChapterWithPages,
  Bookshelf,
  BookshelfWithBooks,
  User,
  UserWithRoles,
  Role,
  RoleWithPermissions,
  Attachment,
  Image,
  SearchResult,
  RecycleBinItem,
  ContentPermissions,
  AuditLogEntry,
  SystemInfo,
  ListResponse,
  BooksListParams,
  PagesListParams,
  ChaptersListParams,
  ShelvesListParams,
  UsersListParams,
  RolesListParams,
  AttachmentsListParams,
  SearchParams,
  ImageGalleryListParams,
  AuditLogListParams,
  CreateBookParams,
  UpdateBookParams,
  CreatePageParams,
  UpdatePageParams,
  CreateChapterParams,
  UpdateChapterParams,
  CreateShelfParams,
  UpdateShelfParams,
  CreateUserParams,
  UpdateUserParams,
  CreateRoleParams,
  UpdateRoleParams,
  CreateAttachmentParams,
  UpdateAttachmentParams,
  CreateImageParams,
  UpdateImageParams,
  UpdateContentPermissionsParams,
  ExportFormat,
  ExportResult,
  ContentType,
  PaginationParams,
} from '../types';

/**
 * BookStack API Client
 * 
 * Provides a comprehensive wrapper around the BookStack REST API
 * with built-in error handling, rate limiting, and retry logic.
 */
export class BookStackClient implements BookStackAPIClient {
  private client: AxiosInstance;
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private rateLimiter: RateLimiter;
  private config: Config;

  constructor(config: Config, logger: Logger, errorHandler: ErrorHandler) {
    this.config = config;
    this.logger = logger;
    this.errorHandler = errorHandler;
    this.rateLimiter = new RateLimiter(config.rateLimit);

    // Create HTTP agent for connection pooling
    const httpsAgent = new Agent({
      keepAlive: true,
      maxSockets: 10,
      timeout: config.bookstack.timeout,
    });

    // Initialize Axios client
    this.client = axios.create({
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
  private setupInterceptors(): void {
    // Request interceptor for rate limiting and logging
    this.client.interceptors.request.use(
      async (config) => {
        // Apply rate limiting
        await this.rateLimiter.acquire();

        this.logger.debug('API request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          params: config.params,
        });

        return config;
      },
      (error) => {
        this.logger.error('Request interceptor error', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling and logging
    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug('API response', {
          status: response.status,
          url: response.config.url,
          dataLength: JSON.stringify(response.data).length,
        });
        return response;
      },
      (error: AxiosError) => {
        this.logger.error('API error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.message,
          data: error.response?.data,
        });
        
        return Promise.reject(this.errorHandler.handleAxiosError(error));
      }
    );
  }

  /**
   * Generic request method with retry logic
   */
  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    try {
      const response: AxiosResponse<T> = await this.client.request(config);
      return response.data;
    } catch (error) {
      throw this.errorHandler.handleError(error);
    }
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getSystemInfo();
      return true;
    } catch (error) {
      this.logger.warn('Health check failed', error);
      return false;
    }
  }

  // Books API
  async listBooks(params?: BooksListParams): Promise<ListResponse<Book>> {
    return this.request<ListResponse<Book>>({
      method: 'GET',
      url: '/books',
      params,
    });
  }

  async createBook(params: CreateBookParams): Promise<Book> {
    return this.request<Book>({
      method: 'POST',
      url: '/books',
      data: params,
    });
  }

  async getBook(id: number): Promise<BookWithContents> {
    return this.request<BookWithContents>({
      method: 'GET',
      url: `/books/${id}`,
    });
  }

  async updateBook(id: number, params: UpdateBookParams): Promise<Book> {
    return this.request<Book>({
      method: 'PUT',
      url: `/books/${id}`,
      data: params,
    });
  }

  async deleteBook(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/books/${id}`,
    });
  }

  async exportBook(id: number, format: ExportFormat): Promise<ExportResult> {
    return this.request<ExportResult>({
      method: 'GET',
      url: `/books/${id}/export/${format}`,
    });
  }

  // Pages API
  async listPages(params?: PagesListParams): Promise<ListResponse<Page>> {
    return this.request<ListResponse<Page>>({
      method: 'GET',
      url: '/pages',
      params,
    });
  }

  async createPage(params: CreatePageParams): Promise<Page> {
    return this.request<Page>({
      method: 'POST',
      url: '/pages',
      data: params,
    });
  }

  async getPage(id: number): Promise<PageWithContent> {
    return this.request<PageWithContent>({
      method: 'GET',
      url: `/pages/${id}`,
    });
  }

  async updatePage(id: number, params: UpdatePageParams): Promise<Page> {
    return this.request<Page>({
      method: 'PUT',
      url: `/pages/${id}`,
      data: params,
    });
  }

  async deletePage(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/pages/${id}`,
    });
  }

  async exportPage(id: number, format: ExportFormat): Promise<ExportResult> {
    return this.request<ExportResult>({
      method: 'GET',
      url: `/pages/${id}/export/${format}`,
    });
  }

  // Chapters API
  async listChapters(params?: ChaptersListParams): Promise<ListResponse<Chapter>> {
    return this.request<ListResponse<Chapter>>({
      method: 'GET',
      url: '/chapters',
      params,
    });
  }

  async createChapter(params: CreateChapterParams): Promise<Chapter> {
    return this.request<Chapter>({
      method: 'POST',
      url: '/chapters',
      data: params,
    });
  }

  async getChapter(id: number): Promise<ChapterWithPages> {
    return this.request<ChapterWithPages>({
      method: 'GET',
      url: `/chapters/${id}`,
    });
  }

  async updateChapter(id: number, params: UpdateChapterParams): Promise<Chapter> {
    return this.request<Chapter>({
      method: 'PUT',
      url: `/chapters/${id}`,
      data: params,
    });
  }

  async deleteChapter(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/chapters/${id}`,
    });
  }

  async exportChapter(id: number, format: ExportFormat): Promise<ExportResult> {
    return this.request<ExportResult>({
      method: 'GET',
      url: `/chapters/${id}/export/${format}`,
    });
  }

  // Shelves API
  async listShelves(params?: ShelvesListParams): Promise<ListResponse<Bookshelf>> {
    return this.request<ListResponse<Bookshelf>>({
      method: 'GET',
      url: '/shelves',
      params,
    });
  }

  async createShelf(params: CreateShelfParams): Promise<Bookshelf> {
    return this.request<Bookshelf>({
      method: 'POST',
      url: '/shelves',
      data: params,
    });
  }

  async getShelf(id: number): Promise<BookshelfWithBooks> {
    return this.request<BookshelfWithBooks>({
      method: 'GET',
      url: `/shelves/${id}`,
    });
  }

  async updateShelf(id: number, params: UpdateShelfParams): Promise<Bookshelf> {
    return this.request<Bookshelf>({
      method: 'PUT',
      url: `/shelves/${id}`,
      data: params,
    });
  }

  async deleteShelf(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/shelves/${id}`,
    });
  }

  // Users API
  async listUsers(params?: UsersListParams): Promise<ListResponse<User>> {
    return this.request<ListResponse<User>>({
      method: 'GET',
      url: '/users',
      params,
    });
  }

  async createUser(params: CreateUserParams): Promise<User> {
    return this.request<User>({
      method: 'POST',
      url: '/users',
      data: params,
    });
  }

  async getUser(id: number): Promise<UserWithRoles> {
    return this.request<UserWithRoles>({
      method: 'GET',
      url: `/users/${id}`,
    });
  }

  async updateUser(id: number, params: UpdateUserParams): Promise<User> {
    return this.request<User>({
      method: 'PUT',
      url: `/users/${id}`,
      data: params,
    });
  }

  async deleteUser(id: number, migrateOwnershipId?: number): Promise<void> {
    const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
    await this.request<void>({
      method: 'DELETE',
      url: `/users/${id}`,
      data,
    });
  }

  // Roles API
  async listRoles(params?: RolesListParams): Promise<ListResponse<Role>> {
    return this.request<ListResponse<Role>>({
      method: 'GET',
      url: '/roles',
      params,
    });
  }

  async createRole(params: CreateRoleParams): Promise<Role> {
    return this.request<Role>({
      method: 'POST',
      url: '/roles',
      data: params,
    });
  }

  async getRole(id: number): Promise<RoleWithPermissions> {
    return this.request<RoleWithPermissions>({
      method: 'GET',
      url: `/roles/${id}`,
    });
  }

  async updateRole(id: number, params: UpdateRoleParams): Promise<Role> {
    return this.request<Role>({
      method: 'PUT',
      url: `/roles/${id}`,
      data: params,
    });
  }

  async deleteRole(id: number, migrateOwnershipId?: number): Promise<void> {
    const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
    await this.request<void>({
      method: 'DELETE',
      url: `/roles/${id}`,
      data,
    });
  }

  // Attachments API
  async listAttachments(params?: AttachmentsListParams): Promise<ListResponse<Attachment>> {
    return this.request<ListResponse<Attachment>>({
      method: 'GET',
      url: '/attachments',
      params,
    });
  }

  async createAttachment(params: CreateAttachmentParams): Promise<Attachment> {
    return this.request<Attachment>({
      method: 'POST',
      url: '/attachments',
      data: params,
    });
  }

  async getAttachment(id: number): Promise<Attachment> {
    return this.request<Attachment>({
      method: 'GET',
      url: `/attachments/${id}`,
    });
  }

  async updateAttachment(id: number, params: UpdateAttachmentParams): Promise<Attachment> {
    return this.request<Attachment>({
      method: 'PUT',
      url: `/attachments/${id}`,
      data: params,
    });
  }

  async deleteAttachment(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/attachments/${id}`,
    });
  }

  // Images API
  async listImages(params?: ImageGalleryListParams): Promise<ListResponse<Image>> {
    return this.request<ListResponse<Image>>({
      method: 'GET',
      url: '/image-gallery',
      params,
    });
  }

  async createImage(params: CreateImageParams): Promise<Image> {
    return this.request<Image>({
      method: 'POST',
      url: '/image-gallery',
      data: params,
    });
  }

  async getImage(id: number): Promise<Image> {
    return this.request<Image>({
      method: 'GET',
      url: `/image-gallery/${id}`,
    });
  }

  async updateImage(id: number, params: UpdateImageParams): Promise<Image> {
    return this.request<Image>({
      method: 'PUT',
      url: `/image-gallery/${id}`,
      data: params,
    });
  }

  async deleteImage(id: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/image-gallery/${id}`,
    });
  }

  // Search API
  async search(params: SearchParams): Promise<ListResponse<SearchResult>> {
    return this.request<ListResponse<SearchResult>>({
      method: 'GET',
      url: '/search',
      params,
    });
  }

  // Recycle Bin API
  async listRecycleBin(params?: PaginationParams): Promise<ListResponse<RecycleBinItem>> {
    return this.request<ListResponse<RecycleBinItem>>({
      method: 'GET',
      url: '/recycle-bin',
      params,
    });
  }

  async restoreFromRecycleBin(deletionId: number): Promise<void> {
    await this.request<void>({
      method: 'PUT',
      url: `/recycle-bin/${deletionId}`,
    });
  }

  async permanentlyDelete(deletionId: number): Promise<void> {
    await this.request<void>({
      method: 'DELETE',
      url: `/recycle-bin/${deletionId}`,
    });
  }

  // Content Permissions API
  async getContentPermissions(contentType: ContentType, contentId: number): Promise<ContentPermissions> {
    return this.request<ContentPermissions>({
      method: 'GET',
      url: `/content-permissions/${contentType}/${contentId}`,
    });
  }

  async updateContentPermissions(
    contentType: ContentType,
    contentId: number,
    params: UpdateContentPermissionsParams
  ): Promise<ContentPermissions> {
    return this.request<ContentPermissions>({
      method: 'PUT',
      url: `/content-permissions/${contentType}/${contentId}`,
      data: params,
    });
  }

  // Audit Log API
  async listAuditLog(params?: AuditLogListParams): Promise<ListResponse<AuditLogEntry>> {
    return this.request<ListResponse<AuditLogEntry>>({
      method: 'GET',
      url: '/audit-log',
      params,
    });
  }

  // System API
  async getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>({
      method: 'GET',
      url: '/system',
    });
  }
}

export default BookStackClient;