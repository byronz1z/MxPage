const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharp = require('sharp');

const output = 'test-output/prompt-review-walkthrough';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(200); }
  throw new Error(`Timeout: ${label}`);
}
exports.models = [
  { modelId: 'gpt-6-luna', label: 'Mock text', capabilities: { text: true, vision: true, structured_output: true }, roles: {}, isDefaultPlanning: true, isDefaultAnalysis: true },
  { modelId: 'gpt-image-2.5-flare', label: 'Mock image', capabilities: { image_gen: true, image_edit: true, real_image_edit: true }, roles: {}, isDefaultHeroImage: true, isDefaultDetailImage: true, isDefaultImageEdit: true },
];
function plan(input) {
  assert.equal(input.requestedHeroCount, 1);
  assert.equal(input.requestedDetailCount, 1);
  return {
    productName: '陶瓷杯', category: '家居日用', facts: ['陶瓷杯，圆形杯口，单侧杯柄'], requirements: [], missingFields: [],
    contentCoverage: ['need', 'selling_points', 'scenarios', 'details', 'specifications', 'trust', 'usage', 'closing'].map(module => ({ module, status: 'covered', sectionIndexes: [1], reason: '根据已知外观介绍商品，不编造规格' })),
    sections: ['主图 · 温暖日常', '详情 · 杯口与杯柄'].map((title, index) => ({ kind: index ? 'DETAIL' : 'HERO', title, objective: '忠实展示商品外观', buyerQuestion: '杯子的外观和细节是什么？', copy: index ? '看清杯口与杯柄细节' : '给日常留一杯温度', evidence: ['user_description'] })),
  };
}
function art(input) {
  return { concept: '暖色自然光，忠实展示杯子外观', palette: ['#F6F1E8', '#8E7361'], typography: '清晰易读的中文字体', sections: input.plan.sections.map((section, sectionIndex) => ({
    sectionIndex, expression: 'photo', prompt: sectionIndex ? '暖白背景，侧面近景展示陶瓷杯的杯口与杯柄，不添加未确认的容量。' : '暖白背景，正面三分之四视角展示陶瓷杯，柔和自然光，主体完整。',
    textBlocks: [{ text: section.copy, role: 'body', x: 5, y: 5, width: 90, fontSize: 24, lineHeight: 1.2, align: 'left' }],
  })) };
}
async function sample(index) {
  // Deliberately labelled fixtures: these validate plumbing, not model image quality.
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900">
    <rect width="720" height="900" fill="${index ? '#eee8df' : '#e7e8e7'}"/>
    <text x="48" y="65" font-family="sans-serif" font-size="22" fill="#74624e">MXPAGE / FLOW TEST</text>
    <text x="48" y="132" font-family="Microsoft YaHei,sans-serif" font-size="36" fill="#332f2a">${index ? '详情图 · 杯口与杯柄' : '主图 · 浅灰桌面'}</text>
    <ellipse cx="360" cy="640" rx="235" ry="35" fill="#bbb4ab" opacity="0.4"/>
    <path d="M470 360 C650 320 650 580 470 555" fill="none" stroke="#9e8670" stroke-width="36"/>
    <path d="M170 350 L200 600 Q330 680 470 600 L500 350Z" fill="#bca288"/>
    <ellipse cx="335" cy="350" rx="165" ry="42" fill="#8e7361"/>
    <ellipse cx="335" cy="350" rx="145" ry="28" fill="#dfcbb5"/>
    <text x="360" y="770" text-anchor="middle" font-family="Microsoft YaHei,sans-serif" font-size="32" fill="#51473c">模拟图片 · 非真实 AI 生成</text>
    <text x="360" y="820" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#74624e">Mock response / Page ${index + 1} / Cost: 0</text>
  </svg>`)).png().toBuffer();
}
exports.respond = async (req, res, { pending, calls, forbidden }) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(req.method, 'POST');
    if (req.url === '/v1/images/edits' || req.url === '/v1/images/generations') {
      const body = req.url.endsWith('/edits') ? Object.fromEntries(await new Response(bytes, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()) : JSON.parse(bytes);
      assert.equal(body.model, 'gpt-image-2.5-flare');
      const index = body.prompt.includes('看清杯口与杯柄细节') ? 1 : 0;
      const png = await sample(index);
      calls.push({ kind: 'IMAGE', model: body.model, prompt: body.prompt });
      pending.push(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); });
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    const body = JSON.parse(bytes);
    assert.equal(body.model, 'gpt-6-luna');
    const system = body.messages[0].content;
    const input = JSON.parse(body.messages[1].content[0].text);
    const kind = system.includes('商品规划模型') ? 'PLAN' : system.includes('视觉分镜模型') ? 'ART_DIRECTION' : system.includes('整套页面检查模型') ? 'SET_REVIEW' : 'IMAGE_REVIEW';
    const value = kind === 'PLAN' ? plan(input) : kind === 'ART_DIRECTION' ? art(input) : { passed: true, issues: [] };
    calls.push({ kind, model: body.model });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'isolated-mock', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  } catch (error) {
    forbidden.push(`${req.url}: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } }));
  }
};

exports.check = async (browser, baseUrl, db, { providerUrl, pending, calls }) => {
  fs.mkdirSync(output, { recursive: true });
  const project = await db.project.create({ data: {
    name: '陶瓷杯 · 提示词流程验收', description: '陶瓷杯，圆形杯口，单侧杯柄。只展示已知外观。', platform: 'general_ecommerce', style: 'generic_clean',
    modelSnapshot: { creationBrief: { name: '陶瓷杯 · 提示词流程验收', description: '陶瓷杯，圆形杯口，单侧杯柄。只展示已知外观。', visualDirection: '暖白背景，自然光', uncertainties: [] }, previewConfig: { heroImageCount: 1, detailSectionCount: 1, quality: 'low' } },
  } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ url }) => localStorage.setItem('mxpage:provider-credentials:v1', JSON.stringify({ apiKey: 'isolated-test-key', baseUrl: url })), { url: providerUrl });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = [], submissions = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/confirm-prompts')) submissions.push(req.postDataJSON()); });
    const upload = await page.request.post(`${baseUrl}/api/projects/${project.id}/assets/upload`, { data: { type: 'MAIN', fileName: 'cup-test-fixture.png', mimeType: 'image/png', base64Data: (await sample(0)).toString('base64') } });
    assert.equal(upload.status(), 201);
    await page.goto(`${baseUrl}/projects/${project.id}/configure`);
    const start = page.getByRole('button', { name: '确认并生成 2 张图片', exact: true });
    await start.waitFor(); await until(() => start.isEnabled(), 'configuration ready');
    await start.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/01-configure.png` });
    await start.click();
    await page.waitForURL(`**/projects/${project.id}/prompts`);
    const panel = page.getByRole('region', { name: '生成前提示词确认' });
    await panel.waitFor();
    const run = await db.detailRun.findFirstOrThrow({ where: { projectId: project.id } });
    assert.equal(run.status, 'WAITING_PROMPTS');
    assert.equal(calls.filter(call => call.kind === 'IMAGE').length, 0);
    const hero = page.getByRole('textbox', { name: '第 1 页完整提示词', exact: true });
    const original = await hero.inputValue();
    assert.equal(original, run.checkpoint.promptReview.pages[0].prompt);
    await panel.screenshot({ path: `${output}/02-hero-prompt.png` });
    assert.equal(await panel.getByRole('textbox').count(), 2);
    assert.equal(await page.getByRole('textbox', { name: '第 2 页完整提示词', exact: true }).inputValue(), run.checkpoint.promptReview.pages[1].prompt);
    await panel.screenshot({ path: `${output}/03-detail-prompt.png` });
    const edited = `用户修改要求：主图改为浅灰桌面，保持杯子的外观和画面文字不变。\n\n${original.replaceAll('暖白背景', '浅灰桌面背景')}`;
    await hero.fill(edited);
    await panel.getByText('有未保存的修改；确认时会一并保存', { exact: true }).waitFor();
    await panel.screenshot({ path: `${output}/04-edited.png` });
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await panel.getByText('已保存，尚未开始生图', { exact: true }).waitFor();
    await page.reload(); await panel.waitFor();
    assert.equal(await hero.inputValue(), edited);
    assert.equal(calls.filter(call => call.kind === 'IMAGE').length, 0);
    await panel.screenshot({ path: `${output}/05-reload-preserved.png` });
    await page.getByRole('button', { name: '确认全部 2 页并生成', exact: true }).click();
    await until(() => calls.filter(call => call.kind === 'IMAGE').length === 1, 'first image request');
    await until(() => panel.count().then(count => count === 0), 'approval panel closed');
    await page.waitForURL(`**/projects/${project.id}/editor`);
    await page.getByRole('region', { name: '任务进度' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/06-generating.png` });
    pending.shift()();
    await until(() => calls.filter(call => call.kind === 'IMAGE').length === 2, 'detail image request after hero');
    // Multipart encoding standardizes line endings to CRLF; compare the text content.
    const prompts = calls.filter(call => call.kind === 'IMAGE').map(call => call.prompt.replaceAll('\r\n', '\n'));
    assert.deepEqual(prompts.slice().sort(), [edited, run.checkpoint.promptReview.pages[1].prompt].sort());
    assert.equal((await db.detailRun.findUniqueOrThrow({ where: { id: run.id } })).checkpoint.promptReview.pages[0].prompt, edited);
    while (pending.length) pending.shift()();
    await until(async () => (await db.detailRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'COMPLETED', 'complete workflow');
    await page.reload();
    await page.getByRole('button', { name: '分图 ZIP（2）', exact: true }).waitFor();
    await page.getByRole('button', { name: '图片列表', exact: true }).click();
    await until(() => page.locator('main img').evaluateAll(images => images.length >= 2 && images.every(image => image.complete && image.naturalWidth > 0)), 'result images');
    await page.locator('main').screenshot({ path: `${output}/07-completed.png` });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '分图 ZIP（2）', exact: true }).click();
    const download = await downloadPromise;
    await download.saveAs(`${output}/result-images.zip`);
    assert.equal(await download.failure(), null);
    await page.getByRole('button', { name: '下载详情长图', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.equal(await db.detailRun.count({ where: { projectId: project.id } }), 1);
    assert.equal(submissions.length, 1);
    assert.equal(calls.filter(call => call.kind === 'IMAGE').length, 2);
    assert.equal(calls.filter(call => call.kind === 'PLAN').length, 1);
    assert.equal(calls.filter(call => call.kind === 'ART_DIRECTION').length, 1);
    const result = { status: 'PASS', isolated: true, paidRequests: 0, imageRequestsBeforeConfirmation: 0, imageRequestsAfterConfirmation: 2, exactEditedPromptSent: true, draftSurvivedReload: true, finalStatus: 'COMPLETED', zipDownloaded: true, errors, calls: calls.map(({ kind, model }) => ({ kind, model })), screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')) };
    fs.writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await context.close(); }
};
