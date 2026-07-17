import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type { BookStackClient } from '../../src/api/client';
import { BookTools } from '../../src/tools/books';
import type { Book, BookWithContents, ListResponse, MCPTool } from '../../src/types';
import type { Logger } from '../../src/utils/logger';
import type { ValidationHandler } from '../../src/validation/validator';

/**
 * Types only a subset of `T`'s methods, each as a bun:test `Mock` carrying that
 * method's real signature.
 *
 * bun:test has no `jest.Mocked<T>` equivalent (the type is commented out in
 * bun-types' `test.d.ts`; only `Mock<T>` is exported), so we derive what we need.
 * Deriving from the real declarations keeps the stubs honest if a signature
 * changes, while picking only the methods under test keeps them robust to the
 * class gaining unrelated new methods (e.g. `BookStackClient.uploadFile`).
 */
type MockedMethods<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

type MockClient = MockedMethods<
  BookStackClient,
  'listBooks' | 'createBook' | 'getBook' | 'updateBook' | 'deleteBook' | 'exportBook'
>;
type MockValidator = MockedMethods<ValidationHandler, 'validateParams'>;
type MockLogger = MockedMethods<Logger, 'debug' | 'info' | 'warn' | 'error'>;

/**
 * Note: no `mock.module()` here, unlike the jest version's
 * `jest.mock('../../src/api/client' | validator | logger)`. `BookTools` takes all
 * three collaborators via its constructor and imports them with `import type`, so
 * those modules are never loaded at runtime by this test and the module mocks were
 * no-ops. Bun's `mock.module()` registry is process-global and would leak into
 * other test files, so registering no-op mocks would be a strict downgrade.
 */

describe('BookTools', () => {
  let bookTools: BookTools;
  let mockClient: MockClient;
  let mockValidator: MockValidator;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockClient = {
      listBooks: mock(),
      createBook: mock(),
      getBook: mock(),
      updateBook: mock(),
      deleteBook: mock(),
      exportBook: mock(),
    };

    // `validateParams` is the only entry point left, and the identity stub matches the
    // real handler's contract: it returns the parsed object, which the handler then
    // destructures. `validateId` used to be mocked here too - it is gone from
    // `ValidationHandler` entirely, so mocking it would type-error against the real
    // declarations this file derives its stubs from.
    mockValidator = {
      validateParams: mock((params: unknown) => params),
    };

    mockLogger = {
      debug: mock(),
      info: mock(),
      warn: mock(),
      error: mock(),
    };

    // Partial stubs: cast at the injection boundary only. `BookTools` exercises
    // just the methods mocked above, so we deliberately do not implement the rest
    // of each class (nor their private fields).
    bookTools = new BookTools(
      mockClient as unknown as BookStackClient,
      mockValidator as unknown as ValidationHandler,
      mockLogger as unknown as Logger
    );
  });

  const findTool = (name: string): MCPTool => {
    const tool = bookTools.getTools().find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool;
  };

  describe('getTools', () => {
    it('should return 6 book tools', () => {
      const tools = bookTools.getTools();
      expect(tools).toHaveLength(6);

      const toolNames = tools.map((tool) => tool.name);
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
      const mockResponse: ListResponse<Book> = { data: [], total: 0 };
      mockClient.listBooks.mockResolvedValue(mockResponse);

      const listTool = findTool('bookstack_books_list');

      const result = await listTool.handler({});

      expect(mockValidator.validateParams).toHaveBeenCalled();
      expect(mockClient.listBooks).toHaveBeenCalled();
      expect(result).toEqual(mockResponse);
    });

    it('should create a book', async () => {
      const mockBook: Book = {
        id: 1,
        name: 'Test Book',
        slug: 'test-book',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        created_by: 1,
        updated_by: 1,
        owned_by: 1,
        tags: [],
      };
      const createParams = { name: 'Test Book', description: 'A test book' };

      mockClient.createBook.mockResolvedValue(mockBook);

      const createTool = findTool('bookstack_books_create');

      const result = await createTool.handler(createParams);

      expect(mockValidator.validateParams).toHaveBeenCalledWith(createParams, 'bookCreate');
      expect(mockClient.createBook).toHaveBeenCalledWith(createParams);
      expect(result).toEqual(mockBook);
    });

    it('should read a book by ID', async () => {
      const mockBook: BookWithContents = {
        id: 1,
        name: 'Test Book',
        slug: 'test-book',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
        created_by: 1,
        updated_by: 1,
        owned_by: 1,
        tags: [],
        contents: [],
      };
      mockClient.getBook.mockResolvedValue(mockBook);

      const readTool = findTool('bookstack_books_read');

      const result = await readTool.handler({ id: 1 });

      // A WIRING CHECK, AND NOT A VALIDATION ONE. Read this for what it is.
      //
      // It says the handler hands the whole request object to `validateParams` under the
      // `id` schema - which is worth pinning, since `validateId()` took a bare id and could
      // not see sibling fields. But `mockValidator` accepts everything, so this assertion
      // cannot tell whether the REAL schema rejects an unknown sibling or a numeric string:
      // reintroduce `{ id: Number(params.id) }` here and it still passes, because the
      // projection of `{id: 1, nmae: 'x'}` is `{id: 1}` and `Number(1)` is 1.
      //
      // What the strict boundary actually does is guarded in
      // tests/unit/strict-validation.test.ts, on the real `ValidationHandler` over a client
      // that records whether it was reached, and over the real HTTP route in
      // tests/transport/tools.test.ts.
      expect(mockValidator.validateParams).toHaveBeenCalledWith({ id: 1 }, 'id');
      expect(mockClient.getBook).toHaveBeenCalledWith(1);
      expect(result).toEqual(mockBook);
    });
  });
});
