# MxPage contributor guide

Read this file first when working on the repository. Product facts and links are in
`llms.txt`; the current release is documented in `docs/releases/v0.3.0.md`.

## Project and commands

- Next.js 14 App Router, React 18, TypeScript, Prisma/SQLite, OpenAI SDK, Electron.
- Use Node.js 24 and `npm ci`; the lockfile is committed.
- `npm run prisma:generate`, `npm run prisma:migrate`, `npm run dev` start source development.
- `npm test` runs isolated model-free tests. `npm run test:detail` covers V4 recovery.
- `npm run typecheck` checks TypeScript. `npm run build:desktop` uses `.next-desktop`.
- Never run a production build into the `.next` directory while a dev server uses it.
- `npm run dist:green` builds Windows x64 ZIP; `npm run dist:mac` builds a ZIP on the
  current Mac architecture. Run `npm run smoke:desktop` against unpacked output.

## Architecture map

- `lib/detail-runs/service-v4.ts`: deterministic workflow, request ledger, checkpoints.
- `lib/detail-runs/structured-model.ts`: single structured JSON model requests.
- `lib/detail-runs/run-lease.ts`: ownership, heartbeat and stop/resume coordination.
- `lib/detail-runs/content-review-v4.ts`, `typesetting-v4.ts`: local content/line repair.
- `lib/detail-runs/supplemental-input.ts`: inferred choices and user-confirmed answers.
- `lib/translation/`: fixed-prompt batch translation, separate from planning.
- `lib/ai/`, `lib/services/provider-runtime.ts`: discovered model IDs and request credentials.
- `lib/monitor/`: usage, billing estimates, CNY display and task timing.
- `lib/tasks/`, `components/tasks/`: shared task status and queue.
- `desktop/`, `scripts/build-desktop.cjs`: bundled local server and user-data startup.

## Invariants

1. New detail runs write `workflowVersion: 4`. Earlier workflows are read-only history;
   never route them into V4 automatically. Do not reintroduce `@openai/agents`, a Runner,
   tool loops, or implicit model repair/retry loops.
2. Persist the request ID before dispatch. Reuse completed plans, storyboards, assets
   and reviews on resume. Preserve uncertain requests after timeout/disconnect; do not
   resend possibly billed requests without the user's explicit retry authorization.
3. Stop prevents new dispatches; already issued calls drain and retain results. Check
   the current lease before state/asset writes. See `docs/workflow-v4-reliability.md`.
4. Quality warnings retain generated images and do not trigger paid regeneration.
5. Canonical text is `textBlocks[].text`. Line wrapping is local code. Allow natural
   rephrasing while preserving known specifications, table cells, numbers and units.
6. Inferred supplemental answers are suggestions until selected. Preserve provenance;
   never silently turn unknown values into confirmed measurements.
7. Use provider-discovered model IDs. Do not silently substitute models or hard-code
   aliases based on a user's abbreviated model name.
8. API keys stay in the user's browser/request context. Do not log, commit, or bundle
   keys, `.env`, SQLite databases, uploads, generated projects or usage logs.

## Testing and Windows edits

- Tests that import runtime services must set temporary `DATABASE_URL` / `STORAGE_ROOT`
  **before dynamic imports**. Assert isolation before writing or clearing a monitor.
  Never use the developer's real database, storage or paid provider in tests.
- Add targeted recovery tests for state changes; use existing mocks. Pure UI changes
  need relevant rendering checks rather than another real generation task.
- Use UTF-8 and cross-platform path APIs. Verify absolute destinations before recursive
  removal; never delete outside the specific build or mkdtemp directory you created.
- Keep local acceptance artifacts in ignored `test-output/` or `public/test-reports/`.

## Documentation and releases

- Update `README.md`, `README.en.md`, release notes and `llms.txt` when behavior changes.
  Run `npm run docs:sync` to refresh `public/llms.txt` (do not edit that copy separately).
- Older design/acceptance documents describe historical decisions. Current source,
  tests and V4 reliability documentation take precedence over old Agent designs.
- Public deployment metadata is optional via `NEXT_PUBLIC_SITE_URL`. Private workspace
  pages must stay `noindex`; do not include project data in sitemap/structured metadata.
- Desktop releases are built on native Windows, macOS ARM64 and macOS x64 runners.
  Native Prisma/sharp binaries must match each package. Publish only after smoke tests.
- Release workflow: `.github/workflows/desktop-release.yml`; version tags must match
  `package.json` and the release-note filename. Include all three ZIPs and SHA256 sums.
- The authoritative publishing repository is `https://github.com/ziguishian/MxPage`.
  Check the target remote before pushing; this checkout may have other remotes.

Copyright © 2026 灵矩绘境 · MxPage. Source license: MIT.
