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

Four prerequisites. **All four are outside this repository and require an
owner/admin** — merging these files implements none of them. Until the npm trusted
publisher (#4) exists, nothing here can publish at all, which is what makes merging
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

**This does not stop a branch from publishing** — see #2. Protecting `main` only
makes the *merge* real.

### 2. Create the `npm-publish` environment — this is the actual boundary

Everything else in this pipeline is a check *inside* a file. `on: push` runs the
workflow **from the ref that was pushed**, so anyone who can push a branch can push
a copy of `release-please.yml` with the branch filter changed, the guards deleted,
and a bare `npm publish` — and it runs. npm's trusted publisher binds
**repository + workflow filename**, *not* the ref, so that copy mints the same OIDC
identity. No merge, no tag, no Release required. Removing `workflow_dispatch` did
not close this; it closed one door into the same room.

The **environment claim** is the one npm-validated field a branch copy cannot
satisfy:

```bash
gh api repos/pnocera/bookstack-mcp-server/environments/npm-publish --method PUT \
  --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api repos/pnocera/bookstack-mcp-server/environments/npm-publish/deployment-branch-policies \
  --method POST -f name='main' -f type='branch'
```

Then name it on the trusted publisher (#4). The two halves lock together:

| A branch copy that… | Fails because |
| --- | --- |
| keeps `environment: npm-publish` | **GitHub** refuses the environment to a run on any ref but `main` — no OIDC token is minted at all. |
| deletes the `environment:` line | **npm** rejects the token: its trusted publisher requires that exact environment claim. |

Optionally add a required reviewer to the environment — that also gives you a
human abort window after the Release PR merges, which nothing else here provides.

> ⚠️ **If you add a reviewer, approve deployments in release order.** Every plain
> `npm publish` also moves the mutable `latest` dist-tag to whatever it publishes.
> Approve `2.1.0` before a still-waiting `2.0.0` and both succeed, both Releases go
> green — and `npm install` then resolves to **2.0.0**. The workflow refuses to move
> `latest` backwards and will fail that older publish rather than do it silently, so
> a genuine backfill has to be published by hand under an explicit `--tag`.

> **Tag protection is *not* on this list, deliberately.** `main`'s ruleset does not
> cover tags, and a pre-placed `refs/tags/v*` is a real nuisance: release-please
> does not reject an existing tag, and GitHub's Create Release **ignores
> `target_commitish` when the tag exists**, so a hostile tag gets a public Release
> and then strands the real release behind a red publish job. The workflow refuses
> to *publish* it (it binds the worktree to the Release PR's own merge commit), so
> this is availability, not integrity.
>
> A tag ruleset does not currently fix it: release-please authenticates with
> `GITHUB_TOKEN`, which is the **GitHub Actions app** — there is no
> "release-please identity" to grant a bypass to. Naming the Actions app as the
> bypass actor would let *any* workflow requesting `contents: write` — including a
> branch copy — bypass the rule, which is worse than not having it. Closing this
> properly means giving release-please a dedicated GitHub App and making that App
> the sole bypass actor. Tracked, not done.

### 3. Let GitHub Actions open the Release PR

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

### 4. Configure the npm trusted publisher

> **npmjs.com → the package → Settings → Trusted Publisher →**
> - organization/repository: `pnocera/bookstack-mcp-server`
> - workflow filename: `release-please.yml` (with the extension)
> - **Allowed action: `npm publish`** — required for any trusted publisher created
>   after 2026-05-20. Omitting it leaves authorization incomplete and the first
>   publish fails *after* the irreversible tag.
> - **environment: `npm-publish`** — **not optional.** This is the half of #2 that
>   lives on npm's side. Leave it blank and the publisher accepts a token from a
>   run on *any* branch of this repository, which is exactly the hole #2 exists to
>   close. It must match `environment:` in the workflow **exactly**.

**These fail at different points** — troubleshoot the right one:

| Missing | Symptom |
| --- | --- |
| #3, the GitHub setting | **No Release PR is ever created.** No PR, no tag, no publish job, nothing to recover. |
| #4, the npm publisher | The PR merges and the **tag and Release are created correctly**; the run then fails at `npm publish` with an auth error. |

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
   required checks pass — they do not start on their own (prerequisite #3). Redo
   this after any bot refresh.
1. In `CHANGELOG.md`: move the `[Unreleased]` body **into** the generated 2.0.0
   section; drop the generated summary where the curated text says it better;
   leave `## [Unreleased]` present but empty.
2. Fix the link refs. **There is no `v1.0.0` tag** — 1.0.0 predates tagging here,
   so any `compare/v1.0.0...` URL 404s. v2.0.0 is the repo's first tag:
   `[2.0.0]: .../releases/tag/v2.0.0` and `[Unreleased]: .../compare/v2.0.0...HEAD`.
   release-please also writes its **own** compare link into the generated heading
   (`## [2.0.0](.../compare/v1.0.0...v2.0.0)`), built from the manifest's last
   version — that one 404s too. Repoint it at the release tag while you are editing
   the section, or tag the real 1.0.0 commit first and leave every link valid.
   From 2.1.0 onward the generated links are correct and need no edit.
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
  all — see prerequisite #3.
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

**If the `Create release` job failed before any tag exists** — the classifier could
not resolve the merged PR for this commit, found a Release PR carrying no
`autorelease` label, or release-please returned **no release when one was
expected** (its title/body no longer parse — most likely after the one-time 2.0.0
hand-edit). This is the one case where the rule above inverts:

```bash
gh run rerun <RUN_ID>                # re-run ALL jobs — nothing irreversible happened
```

The classifier is deliberately fail-loud, because only *this* run may release
*this* Release PR: a later push's run will not do it, so silently treating an
unresolved lookup as "ordinary push" would leave the merged Release PR unreleased
with a green tick. Re-running the whole run re-reads the association once GitHub
has settled. Re-running only the failed job works too; the distinction that matters
is that **before the tag, a full re-run is safe — after it, it is the trap above.**

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
- The protected-environment OIDC reconciliation described in prerequisite #2 —
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

# The commit must already carry the version it is about to claim -- in BOTH files.
# The manifest is release-please's record of the last RELEASED version; if the PR
# bumped package.json but not the manifest, tag and Release still go out green
# while main tells release-please the old version is current, and the next
# automated run replays the wrong history.
AT="$(git show "$SHA:package.json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
[ "$AT" = "$VERSION" ] || { echo "package.json at $SHA is $AT, not $VERSION" >&2; exit 1; }

MAN="$(git show "$SHA:.release-please-manifest.json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))["."]')"
[ "$MAN" = "$VERSION" ] || { echo "manifest at $SHA is $MAN, not $VERSION" >&2; exit 1; }

# LITERAL comparison, not a regex. `grep -q "$VERSION"` matches the [Unreleased]
# compare URL and passes with no heading at all; anchoring it but leaving the
# brackets optional and the tail unbounded still accepts `## [2.0.01] - wrong`,
# `## [2.0.0`, `## 2.0.0]` and `## 2.0.0-junk`.
CL="$(git show "$SHA:CHANGELOG.md")"
awk -v v="$VERSION" '$0 == "## ["v"]" || index($0, "## ["v"] - ") == 1 {f=1} END{exit !f}' <<<"$CL" \
  || { echo "CHANGELOG at $SHA has no '## [$VERSION]' heading" >&2; exit 1; }

echo "releasing $SHA as $TAG"

# Resumable: an interrupted run leaves a local and/or remote tag behind, and a
# blind re-run would die on "tag already exists" and tempt you into copying
# lines past the guards above. An existing tag is fine ONLY if it is already at
# $SHA; anything else is a conflict you must look at.
EXISTING="$(git rev-parse -q --verify "refs/tags/$TAG^{commit}" || true)"
if [ -n "$EXISTING" ]; then
  [ "$EXISTING" = "$SHA" ] || { echo "local $TAG is at $EXISTING, not $SHA" >&2; exit 1; }
else
  git tag -a "$TAG" -m "$TAG" "$SHA"   # annotated, at an explicit SHA
fi

REMOTE="$(git ls-remote origin "refs/tags/$TAG" | cut -f1)"
if [ -n "$REMOTE" ]; then
  # Peel it: a remote ANNOTATED tag advertises the tag object here, not the commit.
  REMOTE_C="$(git ls-remote origin "refs/tags/$TAG^{}" | cut -f1)"; REMOTE_C="${REMOTE_C:-$REMOTE}"
  [ "$REMOTE_C" = "$SHA" ] || { echo "remote $TAG is at $REMOTE_C, not $SHA" >&2; exit 1; }
else
  git push origin "refs/tags/$TAG"     # push the tag itself, by name
fi

# `gh release view` succeeding does NOT mean a published release exists: it
# returns drafts and prereleases too. Check what it actually is.
if REL="$(gh release view "$TAG" --repo "$REPO" --json tagName,isDraft,isPrerelease,publishedAt 2>/dev/null)"; then
  read -r RTAG RDRAFT RPRE RPUB <<<"$(jq -r '"\(.tagName) \(.isDraft) \(.isPrerelease) \(.publishedAt // "null")"' <<<"$REL")"
  if [ "$RTAG" = "$TAG" ] && [ "$RDRAFT" = "false" ] && [ "$RPRE" = "false" ] && [ "$RPUB" != "null" ]; then
    echo "Release $TAG already published — leaving it alone"
  else
    echo "Release $TAG exists but is draft=$RDRAFT prerelease=$RPRE published=$RPUB (tag $RTAG)." >&2
    echo "Publish or delete it deliberately, then re-run. Not guessing." >&2
    exit 1
  fi
else
  gh release create "$TAG" --repo "$REPO" --verify-tag --generate-notes
fi
```

Re-run the whole block to resume: every guard above re-runs, and each step is
skipped only after proving the existing state matches `$SHA`.

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
VERSION=X.Y.Z; TAG="v$VERSION"
REPO=https://github.com/pnocera/bookstack-mcp-server.git
REG=https://registry.npmjs.org
PKG=bookstack-mcp-server

DIR="$(mktemp -d)"; mkdir "$DIR/pkg"; cd "$DIR/pkg"
git init -q
git remote add origin "$REPO"

# FULLY QUALIFIED refs only -- `clone --branch $TAG` would hand you a same-named
# BRANCH if one exists (see the table below).
git fetch -q --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
# NOT --depth 1 for main: a shallow main tip has no parent path to the
# separately fetched tag commit, so the ancestry check below would fail
# spuriously the moment any later PR merged — i.e. exactly when you need this.
git fetch -q origin refs/heads/main:refs/remotes/origin/main
git checkout -q --detach "refs/tags/$TAG^{commit}"

# Prove it is the tag, it is on main, and it says what the tag says.
HEAD_SHA="$(git rev-parse HEAD)"
[ "$HEAD_SHA" = "$(git rev-parse "refs/tags/$TAG^{commit}")" ] \
  || { echo "HEAD is not $TAG" >&2; exit 1; }
git merge-base --is-ancestor "$HEAD_SHA" origin/main \
  || { echo "$TAG is not on main -- it was never merged" >&2; exit 1; }

AT="$(node -p 'require("./package.json").version')"
[ "v$AT" = "$TAG" ] || { echo "package.json is $AT, tag says $TAG" >&2; exit 1; }

# Standalone assignment: if git status FAILS, set -e aborts here. Inlined as
# `[ -z "$(git status --porcelain)" ]` a failure prints to stderr, captures an
# empty string, and the guard PASSES.
STATUS="$(git status --porcelain)"
[ -z "$STATUS" ] || { echo "clone is dirty -- stop" >&2; exit 1; }

bun install --frozen-lockfile

# PIN npm FIRST — before the pack preview, not after. `npm pack` is CLI behaviour
# and its rules have changed across majors, so a preview produced by whatever npm
# happens to be installed is not "what will ship" if a different npm does the
# packing. Pin, prove the pin took, and only then show the operator the files.
#
# The pin matters on its own too: the workflow publishes with 11.6.2, whose
# implicit-`latest` protection refuses to demote the tag below the highest stable
# version. An unpinned local CLI (npm 10) has no such guard.
#
# `--registry` on the install as well: without it a configured private registry
# supplies the CLI itself, however carefully every later call is pinned. And
# ASSERT the version — `npm --version` exits 0 for every npm, so printing it
# proves nothing: a prefix outside PATH, a shell hash, or a wrapper can leave the
# old binary resolving while the install "succeeded".
npm install -g npm@11.6.2 --registry="$REG"
hash -r 2>/dev/null || true
NPM_VERSION="$(npm --version)"
[ "$NPM_VERSION" = "11.6.2" ] || {
  echo "npm is $NPM_VERSION, not the reviewed 11.6.2 — the pin did not take" >&2; exit 1; }

npm pack --dry-run                 # packed by the same npm that will publish

# The dry run above is only a gate if something stops. Nothing else in this
# script can tell an unexpected file from an expected one.
read -r -p "Publish $TAG from $HEAD_SHA? Type the version to confirm: " OK
[ "$OK" = "$VERSION" ] || { echo "aborted" >&2; exit 1; }

# From here the script STOPS deciding and starts showing. Everything above is
# deterministic — the source, the tag, the tarball — and worth automating. Registry
# policy is not: `latest` is mutable, npm offers no "publish only if the registry
# still looks like what I just read", and a local shell is not serialized against
# the workflow's publish job. Three rounds of predicates here were each wrong in a
# different way; the read/write race cannot be closed by adding a fourth.
ERR="$(mktemp)"
if STATE="$(npm view "$PKG" versions dist-tags --json --registry="$REG" 2>"$ERR")"; then
  echo "$STATE"
elif grep -q E404 "$ERR"; then
  echo "(nothing published yet)"
else
  echo "Could not read the registry; refusing to publish blind." >&2; cat "$ERR" >&2; exit 1
fi

read -r -p "Read that. Is any other release in flight right now? Type 'no' to continue: " CLEAR
[ "$CLEAR" = "no" ] || { echo "aborted" >&2; exit 1; }

# ARM npm's own protection — a bare command is NOT enough to prove it is armed.
# npm 11.6.2 runs its refusal-to-demote-`latest` check only when
#   isDefaultTag = config.isDefault('tag') && !manifest.publishConfig?.tag
# is true and `force` is false. So all three of these disable it silently:
#
#   * publishConfig.tag in package.json;
#   * a `tag=latest` in ANY .npmrc or NPM_CONFIG_TAG — `npm config get tag` then
#     prints "latest" exactly as it does by default, but it is no longer npm's
#     DEFAULT, so the check is skipped. Only the short `npm config list`, which
#     prints solely what has been explicitly set, can tell them apart;
#   * force=true, which skips the check outright.
node -e 'if (require("./package.json").publishConfig?.tag) { console.error("package.json sets publishConfig.tag"); process.exit(1); }'
! npm config list | grep -qE '^tag *=' || {
  echo "a tag is configured (.npmrc or NPM_CONFIG_TAG). It reads the same as npm's" >&2
  echo "default but disables npm's greater-version protection. Unset it and re-run." >&2; exit 1; }
[ "$(npm config get force)" = "false" ] || {
  echo "force is enabled; npm would skip its greater-version check. Unset it." >&2; exit 1; }

# Bare, deliberately: the IMPLICIT default tag is what arms that check. Passing
# `--tag latest` explicitly disables the very thing the pin above exists for.
#
# This NARROWS the race; it does not close it. npm reads the packument
# client-side, evaluates, and publishes afterwards, so another publisher can land
# in between — and npm's read helper turns a failed packument read into an EMPTY
# version set, i.e. "nothing newer exists". That is why the in-flight confirmation
# above is load-bearing rather than ceremony, and why the check below is by eye.
npm publish --access public --registry="$REG"

# A DELIBERATE backfill — an older version published after a newer one — instead:
#   npm publish --access public --registry="$REG" --tag backfill
# npm would otherwise refuse it, and refusing is right unless you mean it.

# Show the result. Do not certify it: a comparator here would be announcing that
# mutable external state is safe, having read it a moment ago.
npm view "$PKG" versions dist-tags --json --registry="$REG"
# Unquoted heredoc: $VERSION and $PKG must interpolate. Quoted (<<'CHECK') would
# print the operator a literal "$VERSION" to check against.
cat >&2 <<CHECK

Confirm by eye, against the output above:
  * ${VERSION} is present in versions.
  * dist-tags.latest is the version you intend \`npm install\` to serve.
If this publish took \`latest\` and should not have, repair it deliberately:
  npm dist-tag add ${PKG}@<the version users should get> latest
CHECK
```

**Fully qualified refs, and a fresh directory — both are load-bearing:**

| Instead of | Because |
| --- | --- |
| `git clone --branch vX.Y.Z` | Git resolves the short name against `refs/heads/` **first**. If a branch `vX.Y.Z` exists it wins over the tag, exits 0, and — if that branch declares the same version — passes every check below. Fetch `refs/tags/$TAG` explicitly and nothing can shadow it. |
| `git checkout --detach <tag>` in your own tree | Checking out a tag does **not** discard tracked edits or untracked files; it exits 0 with them still present. `files` ships `src/**`, so a stray file under `src/` or a `README.md` edit is packed into an immutable version that no longer matches the tag. `prepublishOnly`'s typecheck does not notice — a stray non-TypeScript file still compiles. An empty directory cannot inherit any of that. |
| `[ -z "$(git status --porcelain)" ]` | Tests captured **stdout** only. If `git status` fails (not a repo, corrupt index) it writes to stderr, the substitution is empty, and the "clean" guard passes. `set -e` does not fire, because the failure is not the test's exit status. |
| `npm pack --dry-run` then `npm publish` | A dry run proves npm *could* build the tarball, not that a human accepted the file list. Run as a script it scrolls past and publishes. |

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

If you want a window to abort after merge, add a required reviewer to the
`npm-publish` environment from prerequisite #2 — that is a real gate. A Git revert
is not.
