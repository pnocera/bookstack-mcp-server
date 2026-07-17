#!/usr/bin/env bun
/**
 * Bring up the local BookStack stack and provision an API token for testing.
 *
 * Usage:  bun run scripts/integration-up.ts
 *
 * Reuses the test harness so the provisioning logic lives in exactly one
 * place. Safe to re-run: both the compose up and the token provisioning are
 * idempotent.
 *
 * On success it prints the BOOKSTACK_* env values you can paste into a .env
 * file (e.g. to let the `mcp` compose service authenticate).
 */

import { spawn } from 'bun';
import {
  appUrl,
  ensureBookStack,
  isBookStackAvailable,
  waitForBookStack,
} from '../tests/integration/helpers/bookstack';

const REPO_ROOT = new URL('../', import.meta.url).pathname;

async function sh(cmd: string[]): Promise<number> {
  const proc = spawn({ cmd, cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit' });
  return await proc.exited;
}

console.log('==> Starting compose services: db, bookstack');
if ((await sh(['docker', 'compose', 'up', '-d', 'db', 'bookstack'])) !== 0) {
  console.error("!! 'docker compose up -d db bookstack' failed. Is the Docker daemon running?");
  process.exit(1);
}

if (!(await isBookStackAvailable())) {
  console.log(
    `==> Waiting for BookStack at ${appUrl()} (first boot runs migrations; can take minutes)`
  );
  if (!(await waitForBookStack())) {
    console.error(`!! BookStack did not become reachable at ${appUrl()} in time.`);
    console.error('!! Inspect the logs with: docker compose logs -f bookstack');
    process.exit(1);
  }
}
console.log(`==> BookStack is serving at ${appUrl()}`);

console.log('==> Provisioning API token');
const { baseUrl, token } = await ensureBookStack();

console.log('\n==> Ready. Verified token against the live API.\n');
console.log(`BOOKSTACK_BASE_URL=${baseUrl}`);
console.log(`BOOKSTACK_API_TOKEN=${token}`);
console.log('\nRun the integration suite with:\n  RUN_INTEGRATION=1 bun test tests/integration');
