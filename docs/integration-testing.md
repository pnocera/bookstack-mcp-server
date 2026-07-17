# Integration Testing

The integration suite runs against a **real BookStack instance** in Docker, not a mock.
It provisions a BookStack API token automatically, so the whole thing is unattended:
no clicking through the BookStack UI.

- Harness: `tests/integration/helpers/bookstack.ts`
- Smoke test: `tests/integration/smoke.test.ts`
- Convenience script: `scripts/integration-up.ts`

---

## Quick start

```bash
# 1. Start BookStack + MariaDB and provision the API token (idempotent).
bun run scripts/integration-up.ts

# 2. Run the integration suite.
RUN_INTEGRATION=1 bun test tests/integration
```

The first run pulls images and performs BookStack's first boot (DB migrations),
which can take **several minutes**. Later runs start in seconds.

---

## Compose services

Defined in `docker-compose.yml` at the repo root. The integration suite uses two of the
three services; `mcp` is not needed to run these tests.

| Service     | Image                              | Role                                                                    |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `db`        | `mariadb:11`                       | BookStack's database (`bookstackapp` / user `bookstack`).               |
| `bookstack` | `lscr.io/linuxserver/bookstack:version-v26.05.2` | The app under test. Published on **http://localhost:6875**. |
| `mcp`       | built from `./Dockerfile`          | Our MCP server. **Not required** by the integration suite.             |

The BookStack tag is **pinned, not `:latest`**. The whole tool contract in this repo —
56 tools, field shapes, error codes — was verified against v26.05.2, and a floating tag
would silently re-point at a future release, turning an upstream change into a mystery
failure here. Bump it deliberately in `docker-compose.yml`, then re-run the suite.

Bring up only what the tests need:

```bash
docker compose up -d db bookstack
```

Default BookStack admin (seeded by the linuxserver image): `admin@admin.com` / `password`.

---

## How the API token is provisioned automatically

**The core problem:** BookStack only lets you create an API token through its web UI
(*Edit Profile → API Tokens → Create Token*). That makes unattended testing impossible
out of the box.

**The solution:** write the token record directly into the app's database using
`php artisan tinker` inside the `bookstack` container. This is the exact command the
harness runs (see `PROVISION_PHP` in `tests/integration/helpers/bookstack.ts`):

```bash
docker compose exec -T bookstack php /app/www/artisan tinker --execute='
$user = \BookStack\Users\Models\User::query()->where("email", "=", "admin@admin.com")->first();
$token = \BookStack\Api\ApiToken::query()->where("token_id", "=", "mcpintegtokenid0000000000000000")->first()
         ?: new \BookStack\Api\ApiToken();
$token->forceFill([
  "name"       => "MCP Integration Tests",
  "token_id"   => "mcpintegtokenid0000000000000000",
  "secret"     => \Illuminate\Support\Facades\Hash::make("mcpintegsecret000000000000000000"),
  "user_id"    => $user->id,
  "expires_at" => \Illuminate\Support\Carbon::now()->addYears(5)->format("Y-m-d"),
])->save();
echo "PROVISION_OK id=" . $token->id . PHP_EOL;
'
```

The resulting token is used as `Authorization: Token <token_id>:<secret>`:

```bash
curl -s -H "Authorization: Token mcpintegtokenid0000000000000000:mcpintegsecret000000000000000000" \
  http://localhost:6875/api/books
# => {"data":[],"total":0}
```

### Why it's written this way

Three details are load-bearing. Verified against BookStack **v26.05.2**
(`app/Api/ApiTokenGuard.php`, `app/Api/ApiToken.php`):

1. **`forceFill`, not `create()` / `updateOrCreate()` / `fill()`.**
   `ApiToken` declares `protected $fillable = ['name', 'expires_at']`. Mass assignment
   therefore **silently drops** `token_id`, `secret` and `user_id`. You get a saved row
   and a real auto-increment id — but with an empty `token_id`, an empty `secret` and
   `user_id = 0`, so the token can never authenticate and the API answers
   `401 No matching API token was found`. `forceFill` bypasses the fillable guard.
   *This failure looks like success; always verify with a real API call.*

2. **`secret` must be bcrypt-hashed; `token_id` must be plain.**
   The guard looks `token_id` up verbatim and validates the secret with
   `Hash::check($secret, $token->secret)`. Letting the app compute `Hash::make(...)`
   keeps it consistent with whatever hashing config the app uses.
   (A direct SQL `INSERT` also works if you supply your own bcrypt hash — e.g.
   `Bun.password.hash(secret, "bcrypt")` — but tinker avoids hard-coding schema
   and hashing assumptions.)

3. **The token's user needs the `access-api` permission.**
   The guard ends with `$token->user->can(Permission::AccessApi)`. The seeded `Admin`
   role has it by default, which is why the token is bound to `admin@admin.com`.

### Idempotency

Token `token_id` / `secret` are **fixed constants**, and provisioning is
*find-then-`forceFill`* rather than an insert. So:

- re-running the suite rewrites the same row instead of hitting the unique
  `token_id` index or accumulating tokens;
- `ensureBookStack()` first tries the existing token against the live API and only
  shells into the container if that token doesn't already work.

Verified: after three consecutive suite runs, `SELECT COUNT(*) FROM api_tokens` = 1.

> These are throwaway credentials for a local, disposable test instance. Don't reuse
> this pattern against anything real.

---

## Harness API

`tests/integration/helpers/bookstack.ts`:

| Export                                                | Purpose                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ensureBookStack(): Promise<BookStackHarness>`         | Verifies reachability, provisions/reuses the token, **verifies it against the live API**, returns `{ baseUrl, token }`. `baseUrl` includes `/api`; `token` is `id:secret`. Throws with actionable guidance on failure. |
| `isBookStackAvailable(timeoutMs?): Promise<boolean>`   | Cheap liveness probe. Never throws.                                                                  |
| `waitForBookStack(timeoutMs?, intervalMs?)`            | Polls until BookStack serves HTTP (default budget 5 min).                                            |
| `shouldRunIntegration(): Promise<boolean>`             | The gate — see below.                                                                                |
| `provisionToken(attempts?, delayMs?): Promise<string>` | Forces (re)provisioning. Retries; normally called via `ensureBookStack()`.                           |
| `apiFetch(harness, path, init?): Promise<Response>`    | Authenticated `fetch`; `path` is relative (`"/books"`). Sets JSON content-type for bodies.           |
| `apiJson<T>(res): Promise<T>`                          | Parses a response body as `T`. The one place response narrowing happens — see below.                |
| `purgeFromRecycleBin(harness, type, id)`               | Permanently destroys a soft-deleted entity. Returns `true` when it purged a row, `false` when there was no row to purge. **Throws** when cleanup actually failed — see below. |
| `appUrl()` / `apiUrl()` / `tokenString()`              | Resolved URLs and the token string.                                                                  |

Response types: `BookStackBook`, `BookStackList<T>` (the `{ data, total }` list envelope),
`RecycleBinEntry`. These are deliberately **narrow views** — only the fields the suite
uses, not a mirror of BookStack's full API. Widen them as new suites need more.

### Why cleanup failures throw

`purgeFromRecycleBin` distinguishes three outcomes, and the difference matters:

| Outcome | Meaning |
| --- | --- |
| `true`  | A deletion row was found and destroyed — verified by re-reading the bin. |
| `false` | There was no row to purge. An honest "nothing to do", which is what a caller that already purged its own entry sees. |
| **throws** | Cleanup genuinely failed: the recycle-bin read errored, `DELETE /recycle-bin/{id}` answered something other than 200/404, or the row **survived** a purge BookStack claimed to accept. |

This helper used to catch every error and fold it into `false`, reasoning that cleanup
must not turn a passing test red. That reasoning is backwards: it makes a failed purge
indistinguishable from an empty bin, and most callers ignore the boolean anyway. The
live instance settled it — after an all-green run the instance still held role 117 and
several `itest-bin-*` rows, leaked while the suite reported success. A throw is the only
signal a caller cannot ignore.

So **do not wrap cleanup calls in `try`/`catch` to keep a suite green.** A throw here
means fixtures are leaking into every subsequent run; fix the leak instead of muting it.

### Typing response bodies

`Response.json()` resolves to `unknown` under this repo's strict tsconfig, so property
access on a raw parsed body is a `TS18046` error. Use `apiJson<T>()` rather than
`res.json()` plus a local cast — it keeps the narrowing in a single auditable place:

```ts
const body = await apiJson<BookStackList<BookStackBook>>(res);
expect(Array.isArray(body.data)).toBe(true); // body.data is BookStackBook[]
```

`apiJson` verifies the body really is JSON (a stray HTML error page gets a clear message
instead of a confusing `undefined` access downstream), then asserts it to `T`. Be aware
of the honest limit: the `as T` **trusts** the declared shape — it is not schema
validation. Tests should still assert on actual field values, which is what catches a
genuinely wrong payload. The repo is at zero `any`, and biome forbids it; narrow through
`apiJson<T>` instead of reaching for `any`.

### Environment variables

| Variable             | Default                 | Meaning                                                   |
| -------------------- | ----------------------- | --------------------------------------------------------- |
| `RUN_INTEGRATION`    | *(unset)*               | Gate override — see below.                                |
| `BOOKSTACK_TEST_URL` | `http://localhost:6875` | BookStack root URL (**no** `/api` suffix) for the harness. |

---

## How skipping is gated

Integration tests must never break a plain `bun test` on a machine without Docker.
The gate is `shouldRunIntegration()`, fed into bun's **`describe.skipIf()`** via a
top-level `await` at collection time:

```ts
const runIntegration = await shouldRunIntegration();
describe.skipIf(!runIntegration)("BookStack integration smoke", () => { /* ... */ });
```

Note `describe.skipIf(cond)` skips **when `cond` is true**, hence the negation.

| `RUN_INTEGRATION` | BookStack reachable | Result                                       |
| ----------------- | ------------------- | -------------------------------------------- |
| unset             | yes                 | **runs**                                     |
| unset             | no                  | **skips cleanly** (exit 0)                   |
| `1` / `true`      | yes                 | **runs**                                     |
| `1` / `true`      | no                  | **fails loudly** — you explicitly opted in   |
| `0` / `false`     | either              | **skips**                                    |

Auto-detection keeps the default developer/CI run green; `RUN_INTEGRATION=1` is the
explicit opt-in that refuses to silently skip (so a broken CI stack fails instead of
passing vacuously). When skipping, the suite prints a one-line hint explaining how to
run it.

Exit codes:

- unreachable + unset → `0` (skips cleanly)
- `RUN_INTEGRATION=0`, stack up → `0`
- `RUN_INTEGRATION=1`, stack up → `0`
- `RUN_INTEGRATION=1`, unreachable → `1` (fails loudly, by design)

Check these yourself rather than trusting a pass/skip count recorded here — counts go
stale the moment a suite is added, while the exit codes above are the actual contract.
Point an unreachable URL at the harness to exercise the bottom two rows:

```bash
RUN_INTEGRATION=0 bun test; echo "exit=$?"                                  # => 0
RUN_INTEGRATION=1 bun test; echo "exit=$?"                                  # => 0 with the stack up
BOOKSTACK_TEST_URL=http://127.0.0.1:9 bun test tests/integration; echo "exit=$?"                  # => 0, skipped
RUN_INTEGRATION=1 BOOKSTACK_TEST_URL=http://127.0.0.1:9 bun test tests/integration; echo "exit=$?" # => 1
```

---

## What the smoke test covers

`tests/integration/smoke.test.ts` drives the BookStack REST API **directly via `fetch`**
and deliberately imports nothing from `src/`, so it validates the harness and the live
stack independently of the server code:

1. provisions a working API token;
2. re-running provisioning reuses the same token (idempotency);
3. `GET /api/books` → `200` + JSON (`data` array + `total`);
4. a bogus token → `401`;
5. full lifecycle: `POST /api/books` → `200`, read back → `200`, `DELETE` → `204`,
   read again → `404`, then purge from the recycle bin.

It cleans up after itself, including an `afterAll` safety net that removes anything a
failed assertion left behind.

Residue is worth checking rather than assuming — the instance is shared and persistent,
and a suite that reports success can still leave fixtures behind. Ask it directly:

```bash
AUTH="Authorization: Token mcpintegtokenid0000000000000000:mcpintegsecret000000000000000000"
for p in books chapters pages shelves recycle-bin; do
  printf '%-12s ' "$p"; curl -s -H "$AUTH" "http://localhost:6875/api/$p?count=1" |
    grep -o '"total":[0-9]*' | head -1
done
```

Adding a suite? Reuse the harness:

```ts
import { apiFetch, ensureBookStack, shouldRunIntegration } from "./helpers/bookstack";

const runIntegration = await shouldRunIntegration();

describe.skipIf(!runIntegration)("my suite", () => {
  let harness: BookStackHarness;
  beforeAll(async () => { harness = await ensureBookStack(); });
  // ...
});
```

---

## Running it manually

```bash
# Start just the backing services.
docker compose up -d db bookstack

# Watch first boot (migrations) if it seems slow.
docker compose logs -f bookstack

# Is it up? (302 -> /login means yes)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:6875

# Provision the token by hand (idempotent) - see the tinker command above,
# or just let the harness do it:
bun run scripts/integration-up.ts

# Hit the API yourself.
curl -s -H "Authorization: Token mcpintegtokenid0000000000000000:mcpintegsecret000000000000000000" \
  http://localhost:6875/api/books

# Run the suite.
RUN_INTEGRATION=1 bun test tests/integration

# Run a single file.
RUN_INTEGRATION=1 bun test tests/integration/smoke.test.ts
```

Reset to a clean slate (destroys the DB and all BookStack data — next boot re-runs
migrations and takes minutes again):

```bash
docker compose down -v
```

---

## Gotchas

**First boot is slow.** BookStack runs DB migrations on first start; several minutes is
normal, plus image pull time. Never use a fixed `sleep` — poll. `waitForBookStack()`
polls for up to 5 minutes by default.

**HTTP-up ≠ ready.** BookStack can serve HTTP shortly before first-boot seeding creates
the `admin@admin.com` user, so a cold-start provisioning attempt can lose the race and
report `no user admin@admin.com`. `provisionToken()` retries (5 attempts, 5s apart).

**`mariadb:11` has no `mysqladmin`.** The image dropped the legacy `mysql*` symlinks in
favour of the `mariadb-*` names. The compose healthcheck must use `mariadb-admin ping`;
with `mysqladmin` it fails with `not found` (exit 127), the `db` service never turns
healthy, and `bookstack` never starts at all because of its
`depends_on: condition: service_healthy`. (Fixed in `docker-compose.yml`; use
`mariadb`, not `mysql`, for shell queries too.)

**Mass assignment silently produces a dead token.** See "Why it's written this way"
above — the single biggest trap. Always confirm with a real authenticated request;
a saved row with an id proves nothing.

**`DELETE /api/books/{id}` is a soft delete.** The book leaves `GET /books` but stays in
the recycle bin forever, so tests that only call `DELETE` slowly fill it. Use
`purgeFromRecycleBin()` (`DELETE /api/recycle-bin/{deletionId}`) for real cleanup.

**BookStack v26 consolidated the entity tables.** There is no `books` table any more —
books, chapters and pages live in a single `entities` table (with `entity_page_data`
etc.). Poking at the DB directly with pre-v26 table names fails with
`Table 'bookstackapp.books' doesn't exist`.

**The `ApiToken` namespace moves between versions.** It is `BookStack\Api\ApiToken` on
v26.05.2 (not `BookStack\Users\Models\ApiToken`, which some versions/docs use). The
`User` model is `BookStack\Users\Models\User`. If provisioning starts failing with a
class-not-found error after an image update, check the namespace first:

```bash
docker compose exec -T bookstack sh -c 'cat /app/www/version; find /app/www/app -iname "ApiToken.php"'
```

**`bun test` does not typecheck.** A green test run says nothing about types — bun strips
them. CI gates separately on `bunx tsc --noEmit`, so a suite can pass locally and still
fail the build (this bit us: 11 `TS18046` errors from `unknown` response bodies, all
invisible to `bun test`). Before pushing, run the same three checks CI does:

```bash
bunx tsc --noEmit      # must be clean, including tests/
bunx biome check tests/
bun run test:integration
```

**Tests share one instance.** The suite runs against a persistent instance, not a fresh
DB per test. Use unique names (the smoke test suffixes with `Date.now()`) and clean up,
rather than assuming an empty instance.

**The `mcp` service needs two tokens, and they do different jobs.** It refuses to *start*
without `MCP_AUTH_TOKEN` (the inbound secret for `POST /message`) and reports *unhealthy*
without a working `BOOKSTACK_API_TOKEN` (the outbound credential its `/health` probe
spends). Compose reads both from a `.env` beside `docker-compose.yml`; feed it the
provisioned test token plus a secret of your own:

```bash
{
  echo "BOOKSTACK_API_TOKEN=mcpintegtokenid0000000000000000:mcpintegsecret000000000000000000"
  echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)"
} > .env
```

With only `BOOKSTACK_API_TOKEN` set, the container does not stay unhealthy — it never
listens at all and restart-loops. `docker compose logs mcp` shows
`MCP_AUTH_TOKEN is not set`. Then call it with the secret you generated:

```bash
docker compose up -d mcp
curl -X POST http://localhost:3000/message \
  -H "Authorization: Bearer $(grep '^MCP_AUTH_TOKEN=' .env | cut -d= -f2)" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

None of this is needed to run the integration suite itself, which talks to BookStack
directly and never starts the `mcp` service.

---

## CI

Plain `bun test` is safe in CI without Docker: the integration suite auto-skips.
To actually exercise it, start the stack, wait for readiness, then run with
`RUN_INTEGRATION=1` so a missing stack fails the build instead of vacuously passing.
