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

Presets do not publish to marketplaces. This is an image-production workspace, not a storefront builder.

## Current screenshots

Captured from the running **v0.3.0 application on October 17, 2026**. Only the homepage and result editor are shown. The editor uses the latest local candle project, including phone preview, image editing and per-stage/image timing.

![MxPage v0.3.0 homepage](docs/screenshots/v0.3.0/home.jpg)

<details>
<summary>Result editor — phone preview, editing and task timing</summary>

![MxPage v0.3.0 candle result editor](docs/screenshots/v0.3.0/editor-phone.jpg)

</details>

[Full screenshots and capture notes](docs/screenshots/README.md)

## Real generated examples

These are actual local outputs, resized/compressed for documentation without retouching their content. Every case includes the source photo, all hero images, individual detail panels and the complete stitched page.

### Latest local projects

| Gradient candle | Aroma burner | Wood-look desktop diffuser |
| --- | --- | --- |
| [![Candle hero](docs/examples/gradient-candle/hero-1.jpg)](docs/examples/gradient-candle/README.md) | [![Burner hero](docs/examples/aroma-burner/hero-1.jpg)](docs/examples/aroma-burner/README.md) | [![Diffuser hero](docs/examples/wood-diffuser/hero-1.jpg)](docs/examples/wood-diffuser/README.md) |
| 4 heroes + 6 detail panels | 4 heroes + 6 detail panels | 3 heroes + 4 detail panels |
| [Full page · 1080 × 8640](docs/examples/gradient-candle/detail-long.jpg) | [Full page · 1080 × 8640](docs/examples/aroma-burner/detail-long.jpg) | [Full page · 1080 × 5760](docs/examples/wood-diffuser/detail-long.jpg) |

**Gradient candle — all six detail panels**

[![Candle detail overview](docs/examples/gradient-candle/detail-overview.jpg)](docs/examples/gradient-candle/detail-long.jpg)

**Aroma burner — all six detail panels**

[![Burner detail overview](docs/examples/aroma-burner/detail-overview.jpg)](docs/examples/aroma-burner/detail-long.jpg)

**Desktop diffuser — all four detail panels**

[![Diffuser detail overview](docs/examples/wood-diffuser/detail-overview.jpg)](docs/examples/wood-diffuser/detail-long.jpg)

These three projects used `gpt-6-luna` and `gpt-image-2.5-flare`, with requested quality `auto`. Their recorded review status is `PARTIAL`. Some specifications came from user-selected model estimates; they are demonstration inputs, not measured product facts. Individual case pages preserve provenance and review limitations.

### Tea set and mug studies

| Lidded tea vessel | Mug — complete-content retest | Mug — Round 2 |
| --- | --- | --- |
| [![Tea hero](docs/examples/tea-set/hero-1.jpg)](docs/examples/tea-set/README.md) | [![Complete mug hero](docs/examples/mug-complete/hero-1.jpg)](docs/examples/mug-complete/README.md) | [![Round 2 mug hero](docs/examples/mug-round2/hero-1.jpg)](docs/examples/mug-round2/README.md) |
| 3 heroes + 8 detail panels | 3 heroes + 8 detail panels | 3 heroes + 4 detail panels |
| [Full page · 1080 × 11520](docs/examples/tea-set/detail-long.jpg) | [Full page · 1080 × 11520](docs/examples/mug-complete/detail-long.jpg) | [Full page · 1080 × 5760](docs/examples/mug-round2/detail-long.jpg) |

<details>
<summary>Expand tea and mug detail-page overviews</summary>

[![Tea eight-panel overview](docs/examples/tea-set/detail-overview.jpg)](docs/examples/tea-set/detail-long.jpg)

[![Complete mug eight-panel overview](docs/examples/mug-complete/detail-overview.jpg)](docs/examples/mug-complete/detail-long.jpg)

[![Round 2 mug four-panel overview](docs/examples/mug-round2/detail-overview.jpg)](docs/examples/mug-round2/detail-long.jpg)

</details>

These three studies used `gpt-6-luna` and `gpt-image-2.5-flare` at `low` quality. Outputs retain review warnings or incomplete reviews; they are not certified listing-ready assets. [All cases, source photos and notes](docs/examples/README.md).

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
