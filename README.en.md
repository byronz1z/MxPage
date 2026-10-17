# MxPage · AI e-commerce image workspace

[简体中文](README.md) · **English** · [Desktop downloads](https://github.com/ziguishian/MxPage/releases/latest) · [Release notes](docs/releases/v0.3.0.md) · [AI documentation](llms.txt)

MxPage is an MIT-licensed, locally deployable workspace for product hero images, complete e-commerce detail pages, batch image translation and Xiaohongshu / RED posts. Maintained by **Lingju Huijing (灵矩绘境 / MatrixInspire)**.

**v0.3.0 replaces the Agent tool loop with a deterministic V4 workflow and individual structured JSON requests through the OpenAI SDK.** Scheduling, checkpoints, layout, retries and recovery are controlled by code. There is no `@openai/agents` dependency.

## Features

- Evidence-based product planning, buyer needs, selling points, scenarios, confirmed specifications and complete visual storyboards.
- Category/platform prompts, 3–10 hero images and 4–20 detail images per detail task.
- Sequential confirmation dialogs: concrete suggested answers plus custom input. Suggestions require selection; unknown dimensions are not silently treated as measured facts.
- First hero image precedes the rest; image concurrency is capped at two.
- Phone mockup preview, per-image editing/version history, ZIP and stitched detail-page exports.
- Independent fixed-prompt translation: single images, folders, multiple languages and source/result comparison. No product-planning Agent.
- Shared task queue, stage/per-image timing, API cost and stability charts, CNY estimates with editable conversion.
- Local avatar/profile, rolling 12-month usage heatmap, model settings and appearance.

Presets do not publish to marketplaces. This is an image-production workspace, not a storefront builder. [Examples and provenance](docs/examples/README.md); [historical v0.2.0 screenshots](docs/screenshots/README.md).

## Desktop downloads

Download from [Releases](https://github.com/ziguishian/MxPage/releases/latest):

| Platform | v0.3.0 asset |
| --- | --- |
| Windows x64 | `MxPage-0.3.0-windows-x64.zip` |
| macOS Apple Silicon | `MxPage-0.3.0-macos-arm64.zip` |
| macOS Intel | `MxPage-0.3.0-macos-x64.zip` |

Extract the entire ZIP and open `MxPage.exe` or `MxPage.app`. No separate Node.js installation is needed. The Mac app can be moved to Applications. These are installation-free archives; user data stays in the OS data directory rather than beside the executable:

- Windows: `%APPDATA%/MxPage/`
- macOS: `~/Library/Application Support/MxPage/`

Quit and back up that directory before replacing application files. Packages have no commercial signing certificate or Apple notarization; macOS uses ad-hoc signing. The OS may require confirmation of the trusted source. Verify downloads with `SHA256SUMS.txt`.

## First run

1. Bottom-left avatar menu → API configuration: enter your own compatible endpoint/key.
2. Discover models and check the connection. The badge shows connection state, image model and last validation time.
3. This release's detail workflow uses discovered **GPT-6 Luna / GPT Image 2.5 Flare** IDs; dated variants are not substituted automatically. Your gateway must support structured JSON and image generation/editing. Abbreviated model names are not fabricated into IDs.
4. Upload references and known facts, then confirm supplemental answers.
5. Start with a small set at low quality and review cost/output before scaling up.

Model credits and fees are separate. Discovering a model does not verify every image parameter supported by a gateway.

## Workflow and recovery

```text
PREPARE → PLAN → WAITING_INPUT (if needed) → ART_DIRECTION
        → GENERATE → IMAGE_REVIEW → SET_REVIEW
        → COMPLETED / PARTIAL / FAILED
```

Resume reuses completed plans, storyboards, assets and reviews. Request IDs are persisted before dispatch; heartbeat leases guard writes. Stop prevents new dispatches while issued requests drain and retain results.

**Uncertain paid requests are not automatically resent.** Timeouts, disconnects and invalid responses require explicit retry authorization. Review issues retain images rather than triggering paid regeneration. Canonical text comes from `textBlocks[].text`; local code wraps text and preserves known parameters, units and table cells while allowing natural rephrasing.

Up to 12 images receive one set review; larger sets use overlapping groups. Supplemental requests, manual edits and authorized retries may add calls. Earlier workflow versions remain viewable/exportable and do not enter V4 automatically. [Recovery details](docs/workflow-v4-reliability.md).

## Source setup

Requires Git, **Node.js 24** and npm.

```bash
git clone https://github.com/ziguishian/MxPage.git
cd MxPage
npm ci
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell or `cp .env.example .env` on macOS/Linux), set your own `APP_SECRET`, then:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run docs:sync
npm run dev
```

Open `http://localhost:3000`. Source defaults: `prisma/dev.db` and `storage/`. Production uses `npm run build` then `npm start`; first stop any dev server sharing `.next`. Desktop output uses `.next-desktop` separately.

`DATABASE_URL` and `STORAGE_ROOT` configure data paths. `LOCK_BASE_URL` optionally fixes a private gateway. `NEXT_PUBLIC_SITE_URL` enables public homepage canonical metadata and sitemap; leave unset locally. Workspace pages remain `noindex`. Robots directives are not access control: add authentication, TLS and isolation before publicly exposing this personal workspace.

## Develop and package

```bash
npm test
npm run test:detail
npm run typecheck
npm run build:desktop
npm run dist:green       # Windows x64 ZIP on Windows
npm run dist:mac         # Current native architecture ZIP on macOS
npm run smoke:desktop   # Packaged SQLite/Prisma/sharp and local HTTP routes
```

The [release pipeline](.github/workflows/desktop-release.yml) builds and smoke-tests on native Windows, macOS ARM64 and Intel runners before publishing ZIPs and SHA256 sums. Developer data, keys and local test reports are excluded.

Stack: Next.js 14, React 18, TypeScript, Prisma/SQLite, OpenAI SDK and Electron. V4 is in `lib/detail-runs/`, translation in `lib/translation/`, usage/billing in `lib/monitor/`, desktop startup in `desktop/`.

Read [AGENTS.md](AGENTS.md) before code changes. [llms.txt](llms.txt) is the editable product/AI index; `npm run docs:sync` copies it to the app's `/llms.txt`. Older design documents remain historical; current code, tests and V4 documentation take precedence.

## Costs and data

- MIT software does not include model credits. Generation, edits, translation and authorized retries may cost money.
- Monitoring distinguishes returned amounts, usage-based estimates, rough estimates and unpriced records. CNY conversion is configurable, not a live settled bill. [Billing](docs/api-billing.md).
- API keys stay in the current browser's local storage and request context, not the project database. Desktop and ordinary browser settings are separate.
- Files can remain local, but inference images/text go to the configured provider. Generation is not fully offline.
- Review product identity, translations, parameters and claims before publication. Selected simulated suggestions retain provenance and must not be represented as measured/certified facts.

[Translation](docs/translation-workflow.md) · [Task queue](docs/global-task-queue.md) · [Issues](https://github.com/ziguishian/MxPage/issues) · [MIT license](LICENSE)

Copyright © 2026 灵矩绘境 · MxPage / MatrixInspire.
