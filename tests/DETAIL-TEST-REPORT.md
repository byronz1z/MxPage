# Detail workflow test report

Date: 2026-09-28

Follow-up on 2026-09-29: [phone preview and authorized charger image-generation acceptance](PHONE-PREVIEW-ACCEPTANCE.md). That pass produced and verified ten images and exports after manually correcting the product brief. It does not change the failed automatic-recognition result below.

## Result

`npm run test:detail`: 22 passed, 0 failed (21 scenarios plus parent test).
`npx tsx --test tests/provider-errors.test.ts`: 8 passed, 0 failed.
`npx tsx --test tests/batch-files.test.ts`: 4 passed, 0 failed.
`npx tsc --noEmit`: passed.

Automated tests use an isolated temporary SQLite database, temporary asset storage, the official Agents SDK, and a local simulated HTTP provider. Those tests do not change production provider settings or user projects and make no paid model requests. The separately authorized live recognition test below used the user's existing project and browser credential.

## Verified

- Product preparation now uses a fixed two-pass workflow: one draft from original images, then one review with originals plus four overlapping crops of the main image. Both use the selected recognition model through the official SDK. Crops are derived from source pixels, enlarged to fit 1024 px; the original input is retained. Corrections and review metadata are saved only after the second tool submits. A failed review preserves the previous result and never publishes the unreviewed draft. Duplicate requests and cached refreshes do not multiply either stage.
- For the reported charger, inspected the stored original (756 × 762 PNG); it visibly reads 65W / HAVIT and shows round pins. The prior provider output read 55W despite high-detail input, so transport tests do not establish perceptual correctness. The authorized live test below confirms that local review still does not meet visual acceptance.

- Preparation compatibility now tests only image input and a validated tool submission; both the probe and preparation stop at the first completed tool. A fixture that rejects tool-result messages can still perform preparation. Planning retains image/tool-result roundtrip validation via a second structured tool, rather than an exact free-text reply.
- Compatibility caches are isolated by role, so a recognition check cannot bypass planning checks for the same model. Wrong observed colors, wrong returned tokens, and incorrect returned-image colors remain rejected. Bare gateway URLs try `/v1` first; auth/rate-limit failures stop immediately. Error messages identify model, endpoint and a bounded, credential-free failure reason.

- Product preparation now selects the configured image-recognition model independently of the planning model. SDK requests carry `detail: high`; a 1800 px fixture retains its resolution. Persisted provenance records model ID, image count and analysis time, without credentials.
- Explicit reanalysis refreshes old cached suggestions; simultaneous requests share one analysis. Normal refresh uses the saved result, failed reanalysis preserves it, and missing recognition configuration does not silently fall back to the planning model.
- Batch progress reads run status before output images, avoiding a race where COMPLETED was returned with an older, incomplete image list.
- Browser confirmed the affected charger's old prefill and the new reanalysis control. An earlier in-app browser attempt had no API key. The live retest then used the user's configured Chrome session; credentials were neither copied nor printed.

- One-click Xiaohongshu: a text-only brief produces five images through the generations endpoint, complete title/caption/tags, the requested language, saved versions and exports. Repeated startup uses the same run. Browser confirms one required input and an optional reference uploader, with no plan approval step. Live image quality was not evaluated.

- Multi-language translation: 2 source images × 2 languages, independent projects and physical source copies, original assets unchanged, ordering and versions preserved, idempotent submission, separate long-image exports. Translation prompts omit creative redesign instructions and request automatic canvas sizing.
- Translation browser checks: single image with two languages yields count 2; two images as one set yield count 4; grouped folder with three images and two languages yields count 6. No live provider was invoked by browser checks.

- Deterministic workflow performs image generation, correction scheduling and finishing; these operations are not exposed as Agent tools. Agent tools are restricted to product planning and visual judgment.
- Batch progressive results, stable startup keys, cancellation preserving in-flight output, resume without duplicate images, question isolation, expired heartbeat recovery and uncertain-request isolation.
- Browser directory selection: flat folder resolves to 2 independent products; nested folder resolves to 2 products with 2 + 1 reference images. Homepage mode switching preserves selected groups.

- Creation preparation: official SDK sees source images, parallel requests share one analysis, persisted suggestions avoid repeat calls, no image generation during preparation.
- Image prompts include platform direction and product fidelity rules; quality is carried through generation and subsequent edits.
- Browser checks: upload placeholder replacement, stacked previews, main-image switching, separate configuration page with editable prefilled fixture data, five platform choices, gallery overlays and whole-card navigation. Browser fixture was removed afterward. Live-provider visual quality has not been re-evaluated in this pass.

- Agent model ID `gpt-6-luna`; Chat Completions tool calls use `reasoning_effort: none`.
- Image request model ID `gpt-image-2.5-sunburst`.
- Authentication and rate-limit failures prevent startup without generating images.
- Responses rejection falls back to SDK Chat Completions, including image/tool-result roundtrip.
- Duplicate start and duplicate generation do not add image calls or versions.
- Optional questions pause and resume; blocking questions require additional assets.
- Uncertain image requests pause until explicit retry.
- Cancel retains the in-flight result; resume generates only remaining images.
- Expired execution leases become interrupted.
- A failed visual check gets at most one correction; still-failed results stay PARTIAL and remain exportable.
- API route handlers create a project, upload material, and generate the default 4 hero / 6 detail images.
- Single-image editing adds one image; whole-page translation adds ten.
- Historical version activation updates the effective image.
- Long PNG output is 1080 px wide with proportional scaling and ordered detail sections; missing detail images block complete export.
- ZIP contains four hero images, six detail images and a manifest. Rejoining ZIP detail images matches the long PNG byte for byte.
- Project JSON and run persistence do not contain the fixture API key.

## Authorized live recognition test — failed visual acceptance

- User explicitly approved sending this charger image and four derived crops to CloseAI (`api.openai-proxy.org`) using `gpt-6-luna`, for two analysis requests and an optional compatibility check. One reanalysis was performed; no detail images were generated and no additional retries were triggered.
- Project: `cmulf5guw004cjd7kem9qgf7j`. Requests completed on 2026-09-28 at 15:52:44–15:52:58 UTC. One compatibility request and two analysis requests returned HTTP 200. Requested model ID was `gpt-6-luna`; the logs cannot independently verify the gateway's underlying model routing.
- Provider request durations: compatibility 2,767 ms, draft 5,536 ms, review 9,162 ms (17,465 ms total, excluding application overhead). Reported usage: 5,008 input tokens and 782 output tokens across all three requests. Actual cost was not returned (`actualCostUsd: null`); it must not be reported as zero.
- Final result read **65W** correctly but still misread **HAVIT** as **HAIT**. The review's correction list says its draft had read **HI WT**. Pin shape remained contradictory: **“两根扁平圆脚插销”** instead of the visible round pins. The model claimed to have reviewed the details, but that claim is not evidence of accuracy.
- The final brief and model-review metadata were saved by the application's normal reanalysis flow. Screenshot: `../../ui-review/charger-recognition-reviewed.png`. This is a failed real quality check, despite passing transport, schema and workflow tests. No charger-specific expected text was inserted into the production prompts.

## Remaining acceptance work

Recognition quality remains unresolved for the current gateway/model combination. The two-pass workflow improves this sample's power-label reading but does not reliably correct lettering or shape. A further comparison of recognition approaches requires separate real-model evaluation; this single test does not prove general accuracy. At this report's original cutoff, generated product quality, actual image-model access and image-generation costs were unverified; see the linked follow-up for the subsequent image-generation test and its limitations.

HTTP route handlers are exercised in-process; this is not a full browser end-to-end test or an actual service-process restart test. The Responses success path, Windows installer packaging and representative real-product quality evaluation were not tested in this run.

Use the application's existing browser credential for approved live acceptance testing; do not copy credentials into chat or repository files.
