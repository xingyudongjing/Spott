# Spott Unified Repository Baseline Design

## Goal

Create one trustworthy Git boundary at `/Users/yaokai/Code/xingyu/Spott` so every iOS, Web, Ops, API, Worker, contract, database, infrastructure, test, and documentation change can be reviewed and reverted together.

This baseline is the prerequisite for the product roadmap. It changes no product behavior.

## Current Evidence

- The product root is not a Git repository.
- `apps/web/.git` and `apps/ops/.git` exist, but both repositories have no commits and no remotes.
- Every file in those nested repositories is untracked, so they provide no recoverable history.
- The root already contains the intended monorepo workspace configuration and a single `pnpm-lock.yaml`.
- A high-confidence credential-pattern scan found no matching private key, cloud access key, GitHub token, Slack token, or payment secret in the proposed source scope.
- `apps/web/.env.local`, build outputs, Turbo caches, local PostgreSQL data, TypeScript build information, Xcode user state, and generated document QA renders must not enter the baseline.

## Chosen Approach

Use a single root Git repository on `main`.

The repository tracks product source, tests, explicit SQL migrations, OpenAPI and generated contract sources, infrastructure definitions, Xcode project files, lockfiles, product specifications, final documentation artifacts, and the small source assets required to regenerate documents.

It excludes dependencies, caches, compiled output, local databases, local environment files, credentials, IDE user state, test output, and reproducible document render/QA intermediates.

## Nested Repository Migration

Before initializing the root repository:

1. Create the backup directory `/Users/yaokai/Code/xingyu/Spott-git-metadata-backup-20260716T023349` outside the product root.
2. Move `apps/web/.git` to `/Users/yaokai/Code/xingyu/Spott-git-metadata-backup-20260716T023349/apps-web.git`.
3. Move `apps/ops/.git` to `/Users/yaokai/Code/xingyu/Spott-git-metadata-backup-20260716T023349/apps-ops.git`.
4. Record the backup path in the handoff.

Moving rather than deleting keeps the operation reversible. Because neither nested repository has a commit or remote, no source history or remote configuration is being discarded.

## Ignore Boundary

The root `.gitignore` will cover:

- `.env*`, while explicitly retaining `.env.example` files.
- `node_modules`, `.turbo`, `.vinext`, `.wrangler`, `build`, `dist`, `coverage`, `outputs`, and `work` directories at any depth.
- `*.tsbuildinfo`, logs, Playwright/test results, local database state, Xcode `xcuserdata`, DerivedData, SwiftPM state, and editor/Office temporary files.
- Generated document directories under `Spott/docs/_work`: `render_*`, `contact_*`, `qa_strips_*`, and `fonts`.

The final PDF/DOCX product documentation, source Markdown, diagram assets, and document-generation tools remain tracked.

## Baseline Procedure

1. Re-run the sensitive-file and generated-artifact inventory immediately before initialization.
2. Apply the reviewed root ignore rules.
3. Move both nested Git metadata directories to the external backup.
4. Initialize the root repository with branch `main`.
5. Inspect `git status --short --ignored` and verify excluded files remain ignored.
6. Stage the entire trusted source boundary.
7. Run `git diff --cached --check`.
8. Scan the staged file list and staged text for high-confidence secret patterns without printing secret values.
9. Create one baseline commit describing the unified monorepo boundary.
10. Verify the repository is clean and structurally healthy.

## Failure and Rollback

- If either nested repository unexpectedly gains a commit or remote before migration, stop without moving it.
- If a sensitive file or credential pattern is found, unstage it, add the appropriate ignore rule, and report the finding without exposing the value.
- If initialization or staging fails before commit, leave source files untouched and move the two Git metadata backups back to their original locations.
- No history rewrite, force operation, cleanup command, or source deletion is used.

## GitHub Publication

The approved destination is `https://github.com/xingyudongjing/Spott.git`. GitHub reports that repository as empty, so the verified local `main` baseline will become its initial branch without rewriting remote history.

The currently authenticated GitHub CLI account is `yaokai4`, and GitHub reports only `READ` permission for this destination. Local initialization and commit may proceed, but no alternate credentials or account will be assumed. Before pushing, `yaokai4` must receive write access or the CLI must be authenticated as an account with write access.

Once write access is confirmed, add the destination as `origin`, push `main` with upstream tracking, and verify that the remote commit ID exactly matches local `HEAD`.

## Verification

The baseline is accepted only when all of the following are true:

- `git rev-parse --show-toplevel` returns `/Users/yaokai/Code/xingyu/Spott`.
- `git branch --show-current` returns `main`.
- `git log -1 --oneline` shows the baseline commit.
- `git status --short` is empty.
- `git diff --check` and `git diff --cached --check` succeed.
- `git fsck --no-dangling` succeeds.
- `git check-ignore` confirms local environment, build, cache, database, and Xcode user files are excluded.
- Both nested `.git` paths are absent and the timestamped external backups exist.
- `origin` is `https://github.com/xingyudongjing/Spott.git`.
- After authorization is available, `git ls-remote origin refs/heads/main` matches local `HEAD`.

## Next Boundary

After this baseline is approved and verified, the next independent design/plan cycle is Phase 0 session and authorization security. It will cover Web HttpOnly refresh cookies, CSRF, refresh single-flight behavior, safe redirects, session revocation enforcement, and migration away from legacy localStorage sessions.
