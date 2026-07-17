# Releasing

Releases are automated, with one human gate. Normal releases never run
`npm publish` by hand — the no-provenance [escape hatch](#doing-a-release-by-hand-escape-hatch)
below is the last resort.

```
merge a feat:/fix: PR to main
        │
        ▼
release-please opens/updates a PR: "chore(main): release 2.1.0"
   ├─ bumps package.json
   ├─ prepends a CHANGELOG entry
   └─ waits                          ◄── the human gate: nothing ships until you merge
        │
        ▼  you review and merge it
        │
tag v2.1.0 + GitHub Release created
        │
        ▼  same workflow run, `publish` job
npm publish --provenance
```

Both stages live in `.github/workflows/release-please.yml`.

---

## Before you enable publishing

Three prerequisites. **All three are outside this repository and require an
owner/admin** — merging these files implements none of them. Until the npm trusted
publisher (#3) exists, nothing here can publish at all, which is what makes merging
the automation itself safe. Do them **in this order**.

### 1. Protect `main` — do this FIRST

Without it, the human gate is a *claim*, not a control. Anyone who can push to
`main` can push a commit that edits `.github/workflows/release-please.yml` to
publish immediately. That copy still carries the trusted workflow filename and can
request `id-token: write`, so **npm accepts it — with nothing merged**.

`non_fast_forward` alone does **not** close this: it blocks *force* pushes, not
ordinary direct pushes. The **`pull_request` rule** is the one that requires
changes to arrive via a merged PR.

```bash
gh api repos/pnocera/bookstack-mcp-server/rulesets --method POST --input - <<'JSON'
{ "name": "main", "target": "branch", "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "pull_request",
      "parameters": { "required_approving_review_count": 0,
                      "dismiss_stale_reviews_on_push": false,
                      "require_code_owner_review": false,
                      "require_last_push_approval": false,
                      "required_review_thread_resolution": false } },
    { "type": "required_status_checks",
      "parameters": { "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "Typecheck, test, lint" },
                                    { "context": "Docker build and smoke" } ] } },
    { "type": "non_fast_forward" }
  ] }
JSON
```

| Rule | Why it is not optional |
| --- | --- |
| `pull_request` | Makes "nothing publishes without a merge" **true** rather than asserted. |
| `strict_required_status_checks_policy: true` | The PR must be up to date with `main`. Also closes a real race: a stale Release PR can otherwise absorb a later feature through `main` while keeping the earlier version and notes — so that feature never appears in **any** release's semver or changelog. |
| `non_fast_forward` | No force pushes, which would corrupt the history release-please's state machine reads. |

Ensure no bypass actor can push the publishing workflow directly.

> **Defence in depth (recommended).** Put the `publish` job behind a protected
> GitHub [environment][envs] restricted to `main` with a required reviewer, and
> name that environment in npm's trusted publisher. That is an **external**
> boundary: a modified workflow file cannot remove it, whereas *any* check written
> inside the workflow can be deleted by the copy that runs it.

### 2. Let GitHub Actions open the Release PR

*Settings → Actions → General → Workflow permissions →*
**"Allow GitHub Actions to create and approve pull requests"**

Currently **disabled**. Without it release-please cannot open the Release PR at
all.

> ⚠️ **This does not make the Release PR's checks run.** Workflow runs triggered by
> a `GITHUB_TOKEN`-created or `GITHUB_TOKEN`-updated PR start in an
> **approval-required** state — someone with write access must click
> **"Approve workflows to run"** on the PR. Prerequisite #1 requires both CI
> contexts to pass, so until you approve them the Release PR sits with pending
> checks and **cannot be merged**. This is a [separate mechanism][ghtoken] from the
> setting above, and it is easy to misread as a ruleset, CI or release-please
> failure.
>
> It recurs: every time release-please refreshes the PR the head changes, and the
> new head's runs need approving again. If you want this unattended, create/update
> the Release PR with a narrowly scoped GitHub App or PAT instead of
> `GITHUB_TOKEN` — that is a real credential boundary, so decide it deliberately.

[ghtoken]: https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs

### 3. Configure the npm trusted publisher

> **npmjs.com → the package → Settings → Trusted Publisher →**
> - organization/repository: `pnocera/bookstack-mcp-server`
> - workflow filename: `release-please.yml` (with the extension)
> - **Allowed action: `npm publish`** — required for any trusted publisher created
>   after 2026-05-20. Omitting it leaves authorization incomplete and the first
>   publish fails *after* the irreversible tag.
> - environment: set it if you took the defence-in-depth option above

**These fail at different points** — troubleshoot the right one:

| Missing | Symptom |
| --- | --- |
| #2, the GitHub setting | **No Release PR is ever created.** No PR, no tag, no publish job, nothing to recover. |
| #3, the npm publisher | The PR merges and the **tag and Release are created correctly**; the run then fails at `npm publish` with an auth error. |

[envs]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

---

## One-time: the first Release PR (2.0.0)

**Applies once. Read it before merging that PR.**

release-please generates a short 2.0.0 section from commit subjects and inserts it
**above the first version-like heading**. It does **not** consume or rename
`## [Unreleased]`. So the bot's PR looks like:

```
## [2.0.0] - ...      <- generated, ~3 lines of commit subjects
## [Unreleased]       <- the curated notes: breaking changes, ~40 defects, upgrade guidance
```

Left alone, 2.0.0 ships with three lines of notes while everything that actually
documents it stays under "Unreleased" **forever**, carried into every later
release. The PR looks fine at a glance — the 2.0.0 heading is right there.

**There are two separate sources, and the file is not the important one.**
release-please builds the **GitHub Release body from the merged Release PR body**,
not from `CHANGELOG.md`. Fixing only the file leaves the public Release at three
lines.

Before merging the first Release PR:

0. **Approve its workflow runs** ("Approve workflows to run" on the PR) and let both
   required checks pass — they do not start on their own (prerequisite #2). Redo
   this after any bot refresh.
1. In `CHANGELOG.md`: move the `[Unreleased]` body **into** the generated 2.0.0
   section; drop the generated summary where the curated text says it better;
   leave `## [Unreleased]` present but empty.
2. Fix the link refs: `[2.0.0]: .../compare/v1.0.0...v2.0.0` and
   `[Unreleased]: .../compare/v2.0.0...HEAD`.
3. **Edit the PR body too**, replacing the generated notes with the curated ones —
   keeping release-please's parseable structure intact.

> ⚠️ **These edits are not durable.** When another commit reaches `main`,
> release-please rebuilds the Release PR and force-updates the bot branch **and
> body**, discarding your edits. If that happens, reapply them before merging.
> Merge promptly, or land the curated content while nothing else is in flight.

Check the PR's **full `CHANGELOG.md` diff and its body** — not just the title and
version.

From 2.1.0 onward none of this applies: `[Unreleased]` is empty and generated
notes are what a normal release wants.

---

## What decides the version

The Conventional Commit subjects merged since the last release — nothing else:

| Commit | Bump |
| --- | --- |
| `fix: ...` | patch (2.0.0 → 2.0.1) |
| `feat: ...` | minor (2.0.0 → 2.1.0) |
| `feat!: ...` or a `BREAKING CHANGE:` footer | **major** (2.0.0 → 3.0.0) |
| `docs:`, `ci:`, `build:` | patch, under their own section |
| `chore:`, `test:`, `style:` | no release on their own |

**A mislabelled commit ships the wrong semver.** Fix a bug and write
`chore: tweak client` → no release. Break a caller and write `feat:` → a minor
version silently breaks them. The commit message is the release contract; it is
the one thing this pipeline cannot check for you.

Squash-merging uses the **PR title** as the commit subject, so the PR title is
what release-please reads.

---

## What gates a publish

- **The merge** — the only trigger. `publish` runs solely when release-please
  reports it created a Release from a merged Release PR. There is deliberately no
  `workflow_dispatch`: an earlier revision had one, and it was a
  publish-without-merge hole (a Release can be created from any local commit, and
  `gh workflow run --ref <branch>` runs a *branch copy* whose guards can simply be
  deleted; the npm publisher binds repo + filename, not the ref).
- **The tag must equal `v${package.json version}`** — asserted in the job. `npm
  publish` reads `package.json`, not the tag, so without this a tag `v2.0.0` could
  ship `2.0.1`.
- **`prepublishOnly` runs `bun run typecheck`** — a release cannot ship source that
  does not compile. This matters more than usual: the package publishes
  **TypeScript source**, not a bundle, so consumers run exactly what is in the
  tarball.
- **CI** (`ci.yml`) — typecheck, 500+ tests, Biome, Docker build + image smoke.
  **Only actually a gate once the ruleset in prerequisite #1 is applied**; the
  release workflow has no dependency on CI. On the bot's Release PR these runs
  additionally need a human to **approve the workflow runs** before they start at
  all — see prerequisite #2.
- The live integration suite deliberately does **not** run in CI (it needs a real
  BookStack). Run it before a significant release:
  `docker compose up -d db bookstack && bun run test:integration`.

---

## When a publish fails

**If the `publish` job failed** (e.g. the trusted publisher is not configured yet)
— the tag, Release and CHANGELOG are correct; only npm is behind:

```bash
gh run rerun <RUN_ID> --failed      # re-runs ONLY the failed publish job
```

That reuses the original run's `release_created` output, so publish actually
executes. **Never "Re-run all jobs"** — `release_created` is only true in the run
that *creates* the Release, so a full re-run finds nothing pending, **skips publish
and passes green** while npm stays behind.

**If `release-please` itself failed *after* creating the tag** — a rarer split
state, e.g. an API error during its PR comment/label work. `publish` is skipped
because its required job failed. **The pipeline cannot recover this by itself**, by
design: the alternatives were a dispatch input that bypasses the merge gate, or a
token that would let a branch copy publish.

> 🚨 **Retrying twice turns this state green while npm is still missing the
> version.** Do not read a green re-run as reconciliation.
>
> The first `rerun --failed` finds the Release already exists — but it removes the
> `autorelease: pending` label and adds `autorelease: tagged` **before** throwing
> `DuplicateReleaseError`. That run is red, and the state has changed. Any *later*
> rerun searches merged PRs for the pending label, no longer finds this one,
> returns no releases and **succeeds**. `release_created` is then unset, so
> `publish` is skipped and the workflow **passes green** — with npm still behind.
>
> After any post-tag failure, the run's colour tells you nothing. Ask the registry
> about the exact version — and note that **`npm view` exits non-zero for reasons
> other than "absent"**, so a bare exit code is not an answer:
>
> ```bash
> ERR=$(mktemp)
> if npm view bookstack-mcp-server@X.Y.Z version \
>      --registry=https://registry.npmjs.org >/dev/null 2>"$ERR"; then
>   echo "PUBLISHED — nothing to recover"
> elif grep -q E404 "$ERR"; then
>   echo "ABSENT — recover with one of the options below"
> else
>   echo "CANNOT TELL — investigate; do NOT publish"; cat "$ERR"   # ECONNREFUSED, auth, proxy, TLS...
> fi
> ```
>
> Pin `--registry` explicitly. `--access public` sets *visibility*, it does not
> select npmjs — if your npm config points at a private registry, an unpinned
> lookup and publish both succeed **there**, leaving public npm untouched.

Recover with one of:

- The tag-pinned local publish below, accepting **no provenance**; or
- The protected-environment OIDC reconciliation described in prerequisite #1 —
  verify the tag and its merged-PR ancestry, publish only if that exact version is
  absent, and fail on any ambiguous registry response. That is the durable fix: an
  external boundary a workflow copy cannot remove.

---

## What ships

`package.json#files` is the source of truth — `src/**`, `tsconfig.json`,
`README.md`, `.env.example`. That is TypeScript source, and the `bin` starts with
`#!/usr/bin/env bun`, so **Bun is required on the consumer's machine**.
`.npmignore` documents intent only; it must never exclude anything `files` ships.

```bash
npm pack --dry-run   # exactly what a release would contain
```

---

## Doing a release by hand (escape hatch)

If the automation is broken and a release is urgent, **still go through a merged
PR** — that is the gate, and there is no supported way around it:

First, on a branch: bump `package.json` + `.release-please-manifest.json` to the
**same** version, write the CHANGELOG entry yourself, then open, review and merge
that PR. Then tag **the commit that PR merged as** — run this as a script, not as
lines you paste one at a time:

```bash
#!/usr/bin/env bash
set -euo pipefail                    # every guard below only aborts because of this
PR=<pr-number>; VERSION=X.Y.Z; TAG="v$VERSION"; REPO=pnocera/bookstack-mcp-server

# The release target is the REVIEWED PR's merge commit — never "whatever main
# points at now". If anything merged after it, main has already moved on.
SHA="$(gh pr view "$PR" --repo "$REPO" --json state,mergeCommit \
        --jq 'select(.state=="MERGED") | .mergeCommit.oid')"
[ -n "$SHA" ] || { echo "PR $PR is not merged — nothing to release" >&2; exit 1; }

git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main \
  || { echo "$SHA is not on main" >&2; exit 1; }

# The commit must already carry the version it is about to claim.
AT="$(git show "$SHA:package.json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
[ "$AT" = "$VERSION" ] || { echo "package.json at $SHA is $AT, not $VERSION" >&2; exit 1; }

echo "releasing $SHA as $TAG"
git tag -a "$TAG" -m "$TAG" "$SHA"     # annotated, at an explicit SHA
git push origin "refs/tags/$TAG"       # push the tag itself, by name
gh release create "$TAG" --repo "$REPO" --verify-tag --generate-notes
```

Every line of that is load-bearing, because the obvious version of each one fails
**silently** — all of these exit 0:

| Instead of | Because |
| --- | --- |
| `git tag vX.Y.Z` | Creates a *lightweight* tag, which `git push --follow-tags` **does not push** — it carries only *annotated* tags. The push still exits 0. |
| `git push --follow-tags` | Pushes tags only alongside refs it is actually updating, and only annotated ones. Push the tag by name and it always goes. |
| `gh release create` bare | If the remote tag is missing, gh **creates one from the latest state of the default branch** and succeeds — so the Release can point at a commit you never chose. `--verify-tag` aborts instead. (It verifies the tag *exists*, not where it points — that is what the SHA guards above are for.) |
| `git switch main && git rev-parse HEAD` | Tags whatever is on `main` *now*. A PR that merged after yours rides into this version without ever appearing in its changelog or semver. Ask the PR for its merge SHA. |
| `guard \|\| echo "stop"` | **`echo` succeeds**, so the guard returns 0 and the next line runs anyway. A printed warning is not control flow; only `exit 1` under `set -e` is. |

Chain those and the tag, the Release and the tarball can each describe a different
commit, with nothing red anywhere. npm versions are immutable, so that is not
repairable in place.

Creating the Release does **not** publish (a `GITHUB_TOKEN`-created release
triggers nothing). To publish it you must fix the automation, or publish locally
and accept no provenance. Publish from a **fresh clone of the tag** — never from a
working copy you have been using:

```bash
#!/usr/bin/env bash
set -euo pipefail
VERSION=X.Y.Z; TAG="v$VERSION"; REPO=https://github.com/pnocera/bookstack-mcp-server.git

DIR="$(mktemp -d)"
git clone --depth 1 --branch "$TAG" "$REPO" "$DIR/pkg"   # detached at the tag, clean by construction
cd "$DIR/pkg"

AT="$(node -p 'require("./package.json").version')"
[ "v$AT" = "$TAG" ] || { echo "package.json is $AT, tag says $TAG" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "clone is dirty — stop" >&2; exit 1; }

bun install --frozen-lockfile
npm pack --dry-run                 # read this: it is exactly what will ship
npm publish --access public --registry=https://registry.npmjs.org
```

**A fresh clone, not `git checkout --detach` in your own tree.** Checking out a tag
does **not** discard tracked edits or untracked files, and it exits 0 with them
still present. `package.json#files` ships `src/**`, so a stray untracked file under
`src/` — or an unrelated `README.md` edit — is packed into an immutable version
that no longer matches the tag or the Release. `prepublishOnly`'s typecheck does not
notice: a stray non-TypeScript file still compiles fine. An empty directory cannot
inherit any of that.

**`npm publish --provenance` cannot work locally.** Provenance requires a
supported cloud CI runner; an authenticated local shell cannot produce an
attestation.

Keep `.release-please-manifest.json` in step with `package.json`. The manifest
records the last **released** version — not whatever `package.json` says. Seeding
it to an *unreleased* version makes release-please skip that release and propose
the next one, replaying history into the changelog.

---

## Merging the Release PR is the point of no return

There is no undo. Reverting the merge does **not** retract the release: the
surviving run still sees a merged `autorelease: pending` PR and can tag and publish
it. And npm versions are **immutable** — a published version can be deprecated,
never replaced or reused.

- **Before the tag exists:** cancel the workflow run.
- **After npm accepts the version:** you cannot take it back. Publish a corrective
  version and `npm deprecate` the bad one.

If you want a window to abort after merge, use the protected environment from
prerequisite #1 — that is a real gate. A Git revert is not.
