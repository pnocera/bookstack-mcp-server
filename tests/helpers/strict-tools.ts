/**
 * The real tool registry, built on a client that only records what it was asked.
 *
 * Shared by the two BookStack-free suites that assert on the strict boundary:
 * `tests/unit/strict-validation.test.ts` (malformed requests must not reach the client) and
 * `tests/unit/id-schema-contract.test.ts` (the published `minimum` must agree with the
 * runtime id rule). Both need the same two things - real tool classes on a real
 * `ValidationHandler`, and a client that can testify to whether it was called - so the
 * harness lives here rather than being written twice and drifting.
 *
 * Nothing here talks to BookStack, Docker or HTTP.
 */

import type { BookStackClient } from '../../src/api/client';
import { AttachmentTools } from '../../src/tools/attachments';
import { AuditTools } from '../../src/tools/audit';
import { BookTools } from '../../src/tools/books';
import { ChapterTools } from '../../src/tools/chapters';
import { ImageTools } from '../../src/tools/images';
import { PageTools } from '../../src/tools/pages';
import { PermissionTools } from '../../src/tools/permissions';
import { RecycleBinTools } from '../../src/tools/recyclebin';
import { RoleTools } from '../../src/tools/roles';
import { SearchTools } from '../../src/tools/search';
import { ServerInfoTools } from '../../src/tools/server-info';
import { ShelfTools } from '../../src/tools/shelves';
import { SystemTools } from '../../src/tools/system';
import { UserTools } from '../../src/tools/users';
import type { MCPResource, MCPTool } from '../../src/types';
import type { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';

/** One call a tool handler made on the client, reduced to what these tests assert on. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A client that implements every method by recording it and answering `{}`.
 *
 * A Proxy rather than a hand-written stub of `BookStackAPIClient`: the point of these suites
 * is largely that the client is NOT reached, so enumerating its 40-odd methods would be 40
 * lines of ceremony around one fact. It also means a tool added later needs no change here.
 *
 * Nothing downstream of validation is under test, so `{}` is a sufficient answer: every
 * handler these suites drive returns the client's result without reading it.
 */
export function createRecordingClient(): { calls: RecordedCall[]; client: BookStackClient } {
  const calls: RecordedCall[] = [];

  const client = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') {
          return undefined;
        }
        return (...args: unknown[]): Promise<unknown> => {
          calls.push({ method: property, args });
          return Promise.resolve({});
        };
      },
    }
  ) as unknown as BookStackClient;

  return { calls, client };
}

/** Logging is not the subject; keep the output to the test runner's own. */
export const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/**
 * Every tool the server registers, on the real strict validator, over `client`.
 *
 * Mirrors `setupTools()` in src/server.ts, including `ServerInfoTools` last with the live
 * registry maps - so the surface these suites enumerate is the surface the server publishes,
 * rather than a subset that could quietly stop matching it.
 */
export function buildTools(client: BookStackClient): Map<string, MCPTool> {
  const validator = new ValidationHandler({ enabled: true, strictMode: true });
  const registry = new Map<string, MCPTool>();
  const resources = new Map<string, MCPResource>();

  const toolClasses = [
    new BookTools(client, validator, silentLogger),
    new PageTools(client, validator, silentLogger),
    new ChapterTools(client, validator, silentLogger),
    new ShelfTools(client, validator, silentLogger),
    new UserTools(client, validator, silentLogger),
    new RoleTools(client, validator, silentLogger),
    new AttachmentTools(client, validator, silentLogger),
    new ImageTools(client, validator, silentLogger),
    new SearchTools(client, validator, silentLogger),
    new RecycleBinTools(client, validator, silentLogger),
    new PermissionTools(client, validator, silentLogger),
    new AuditTools(client, validator, silentLogger),
    new SystemTools(client, validator, silentLogger),
    new ServerInfoTools(silentLogger, registry, resources),
  ];

  for (const toolClass of toolClasses) {
    for (const tool of toolClass.getTools()) {
      registry.set(tool.name, tool);
    }
  }

  return registry;
}

/** Look a tool up, failing loudly rather than silently skipping it. */
export function requireTool(registry: Map<string, MCPTool>, name: string): MCPTool {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`${name} is not registered`);
  }
  return tool;
}
