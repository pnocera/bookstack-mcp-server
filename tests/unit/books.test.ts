import { BookTools } from '../../src/tools/books';
import { BookStackClient } from '../../src/api/client';
import { ValidationHandler } from '../../src/validation/validator';
import { Logger } from '../../src/utils/logger';

// Mock dependencies
jest.mock('../../src/api/client');
jest.mock('../../src/validation/validator');
jest.mock('../../src/utils/logger');

describe('BookTools', () => {
  let bookTools: BookTools;
  let mockClient: jest.Mocked<BookStackClient>;
  let mockValidator: jest.Mocked<ValidationHandler>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockClient = {
      listBooks: jest.fn(),
      createBook: jest.fn(),
      getBook: jest.fn(),
      updateBook: jest.fn(),
      deleteBook: jest.fn(),
      exportBook: jest.fn(),
    } as any;

    mockValidator = {
      validateParams: jest.fn((params) => params),
      validateId: jest.fn((id) => Number(id)),
    } as any;

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    bookTools = new BookTools(mockClient, mockValidator, mockLogger);
  });

  describe('getTools', () => {
    it('should return 6 book tools', () => {
      const tools = bookTools.getTools();
      expect(tools).toHaveLength(6);
      
      const toolNames = tools.map(tool => tool.name);
      expect(toolNames).toContain('bookstack_books_list');
      expect(toolNames).toContain('bookstack_books_create');
      expect(toolNames).toContain('bookstack_books_read');
      expect(toolNames).toContain('bookstack_books_update');
      expect(toolNames).toContain('bookstack_books_delete');
      expect(toolNames).toContain('bookstack_books_export');
    });
  });

  describe('book operations', () => {
    it('should list books with default parameters', async () => {
      const mockResponse = { data: [], total: 0 };
      mockClient.listBooks.mockResolvedValue(mockResponse);

      const tools = bookTools.getTools();
      const listTool = tools.find(tool => tool.name === 'bookstack_books_list');
      
      const result = await listTool!.handler({});
      
      expect(mockValidator.validateParams).toHaveBeenCalled();
      expect(mockClient.listBooks).toHaveBeenCalled();
      expect(result).toEqual(mockResponse);
    });

    it('should create a book', async () => {
      const mockBook = { id: 1, name: 'Test Book' };
      const createParams = { name: 'Test Book', description: 'A test book' };
      
      mockClient.createBook.mockResolvedValue(mockBook as any);

      const tools = bookTools.getTools();
      const createTool = tools.find(tool => tool.name === 'bookstack_books_create');
      
      const result = await createTool!.handler(createParams);
      
      expect(mockValidator.validateParams).toHaveBeenCalledWith(createParams, 'bookCreate');
      expect(mockClient.createBook).toHaveBeenCalledWith(createParams);
      expect(result).toEqual(mockBook);
    });

    it('should read a book by ID', async () => {
      const mockBook = { id: 1, name: 'Test Book', contents: [] };
      mockClient.getBook.mockResolvedValue(mockBook as any);

      const tools = bookTools.getTools();
      const readTool = tools.find(tool => tool.name === 'bookstack_books_read');
      
      const result = await readTool!.handler({ id: 1 });
      
      expect(mockValidator.validateId).toHaveBeenCalledWith(1);
      expect(mockClient.getBook).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockBook);
    });
  });
});

export {};