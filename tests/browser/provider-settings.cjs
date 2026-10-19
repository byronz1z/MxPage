const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<300;i++) { if (await fn()) return; await sleep(200); } throw new Error('Browser check timed out'); }
(async () => {
  process.chdir(path.resolve(__dirname, '../..'));
  const runId = randomUUID(), dist = `.next-browser-${runId}`, config = `.browser-tsconfig-${runId}.json`;
  fs.copyFileSync('tsconfig.json', config);
  fs.mkdirSync('test-output/provider-browser', { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mxpage-provider-browser-'));
  const filename = path.join(directory, 'test.db');
  const sqlite = new DatabaseSync(filename);
  for (const folder of fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter(x => x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))) sqlite.exec(fs.readFileSync(path.join('prisma/migrations', folder.name, 'migration.sql'), 'utf8'));
  sqlite.close();
  const databaseUrl = `file:${filename.replaceAll('\\', '/')}`;
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const models = ['gpt-text-A', 'gpt-text-B', 'gpt-image-A', 'gpt-image-B'].map(modelId => ({ modelId, label: modelId, roles: {}, capabilities: { text: !modelId.includes('image'), vision: !modelId.includes('image'), image_gen: modelId.includes('image'), image_edit: modelId.includes('image') }, isDefaultPlanning: modelId === 'gpt-text-A', isDefaultAnalysis: modelId === 'gpt-text-A', isDefaultHeroImage: modelId === 'gpt-image-A', isDefaultDetailImage: modelId === 'gpt-image-A', isDefaultImageEdit: modelId === 'gpt-image-A' }));
  const provider = await db.providerConfig.create({ data: { name: 'Browser mock', baseUrl: 'https://browser-mock.invalid/v1', apiKeyEncrypted: 'unused', isActive: true, models: { create: models } } });
  await db.providerConfig.create({ data: { name: 'Second mock', baseUrl: provider.baseUrl, apiKeyEncrypted: 'unused', models: { create: models } } });
  const otherProvider = await db.providerConfig.create({ data: { name: 'Other origin mock', baseUrl: 'https://other-mock.invalid/v1', apiKeyEncrypted: 'unused', models: { create: models } } });
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const n = socket.address().port; socket.close(() => resolve(n)); }); });
  const url = `http://127.0.0.1:${port}`;
  const log = fs.openSync('test-output/provider-browser/server.log', 'w');
  const testEnv = { ...process.env, DATABASE_URL: databaseUrl, STORAGE_ROOT: path.join(directory, 'storage'), NEXT_DIST_DIR: dist, MXPAGE_TEST_TSCONFIG: config, NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of ['LOCK_BASE_URL', 'FORCED_API_BASE', 'FORCED_API_BASE_URL']) delete testEnv[key];
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { windowsHide: true, stdio: ['ignore', log, log], env: testEnv });
  let browser;
  try {
    await until(async () => { try { return (await fetch(`${url}/settings/providers`)).ok; } catch { return false; } });
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : fs.existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }), headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage(); page.setDefaultTimeout(30000);
    async function choose(id, label) { await page.locator(id).click(); await page.getByRole('option', { name: label, exact: true }).click(); }
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let pending = 0, peak = 0, failed = false;
    await page.route('**/api/providers/*/defaults', async route => {
      pending++; peak = Math.max(peak, pending);
      try {
        await sleep(150);
        if (failed) return await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'mock save failure' } }) });
        await route.fulfill({ response: await route.fetch() });
      } finally { pending--; }
    });
    await page.goto(`${url}/settings/providers`);
    await choose('#default-model-text', 'gpt-text-B');
    await choose('#default-model-text', 'gpt-text-A');
    await choose('#default-model-text', 'gpt-text-B');
    await page.getByText('已保存；新任务生效', { exact: true }).waitFor();
    assert.equal(peak, 1, 'saves are serialized');
    assert.equal((await db.modelProfile.findFirst({ where: { providerConfigId: provider.id, isDefaultPlanning: true } })).modelId, 'gpt-text-B');
    await page.reload(); assert.equal(await page.locator('#default-model-text').textContent(), 'gpt-text-B');
    failed = true;
    await choose('#default-model-text', 'gpt-text-A');
    await page.getByText('保存失败，已恢复上次保存值', { exact: true }).waitFor();
    assert.equal(await page.locator('#default-model-text').textContent(), 'gpt-text-B');
    failed = false;
    await choose('#default-model-image_gen', 'gpt-image-B');
    await page.getByText('已保存；新任务生效', { exact: true }).waitFor();
    await page.reload();
    assert.equal(await page.locator('#text-protocol, #structured-output-mode').count(), 0, 'no manual compatibility controls');
    await page.getByText('优先使用官方接口，自动适配兼容服务。切换模型后，首次使用时自动检查连接。', { exact: true }).waitFor();
    assert.equal(await page.locator('#default-model-image_gen').textContent(), 'gpt-image-B');
    await choose('#default-model-vision', 'gpt-text-B');
    await choose('#provider-history', `Second mock / ${provider.baseUrl}`);
    assert.equal(await page.locator('#default-model-text').textContent(), 'gpt-text-A');
    await until(() => pending === 0);
    await choose('#provider-history', `Browser mock / ${provider.baseUrl}`);
    assert.equal(await page.locator('#default-model-vision').textContent(), 'gpt-text-B');
    let discoveryFails = false, saveFails = false;
    await page.route('**/api/providers/discover-models', route => discoveryFails
      ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: '模型列表服务返回 401，未接受当前 API Key。' } }) })
      : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { models, recommendations: { analysisModelId: 'gpt-text-A', planningModelId: 'gpt-text-A', heroImageModelId: 'gpt-image-A', detailImageModelId: 'gpt-image-A', imageEditModelId: 'gpt-image-A' } } }) }));
    await page.route('**/api/providers', route => saveFails && route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'mock config save failure' } }) })
      : route.continue());
    let probes = 0;
    await page.route('**/api/providers/agent-compatibility', route => { probes++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { modelId: 'gpt-text-B', transport: 'responses' } }) }); });
    await page.locator('#provider-api-key').fill('mock-browser-key');
    await page.getByRole('button', { name: '探测并保存', exact: true }).click();
    await page.getByText(/探测通过：已发现 4 个模型并保存配置/).waitFor();
    assert.equal(await page.locator('#default-model-text').textContent(), 'gpt-text-B');
    assert.equal(await page.locator('#default-model-image_gen').textContent(), 'gpt-image-B');
    assert.equal(await db.modelProfile.count({ where: { providerConfigId: provider.id } }), 4, 'no invented preset models');
    assert.equal((await db.providerConfig.findUnique({ where: { id: provider.id } })).textProtocol, 'auto');
    assert.equal(probes, 1);
    const readCredentials = () => page.evaluate(() => JSON.parse(localStorage.getItem('mxpage:provider-credentials:v1')));
    const savedCredentials = await readCredentials();
    assert.equal(savedCredentials.apiKey, 'mock-browser-key');
    for (const failure of ['discovery', 'save']) {
      discoveryFails = failure === 'discovery'; saveFails = failure === 'save';
      await page.locator('#provider-api-key').fill('mock-rejected-key');
      await page.getByRole('button', { name: '仅刷新模型列表', exact: true }).click();
      await page.getByRole('button', { name: '仅刷新模型列表', exact: true }).waitFor();
      await until(async () => !(await page.getByRole('button', { name: '仅刷新模型列表', exact: true }).isDisabled()));
      assert.deepEqual(await readCredentials(), savedCredentials, 'failed refresh/save preserves working credentials');
      assert.equal(await page.locator('#provider-api-key').inputValue(), 'mock-rejected-key', 'failed draft stays editable');
      assert.equal(await db.modelProfile.count({ where: { providerConfigId: provider.id } }), 4);
      assert.equal(probes, 1);
    }
    discoveryFails = false; saveFails = false;
    await page.reload();
    assert.equal(await page.locator('#provider-api-key').inputValue(), 'mock-browser-key');
    models.push({ modelId: 'gpt-image-2', label: 'gpt-image-2', roles: {}, capabilities: { image_gen: true, image_edit: true } });
    await page.getByRole('button', { name: '仅刷新模型列表', exact: true }).click();
    await page.getByText('模型列表已刷新并保存：共 5 个，图像生成 3 个。未发送文本、识图或生图请求。', { exact: true }).waitFor();
    assert.equal(probes, 1, 'catalog-only refresh never probes models');
    assert.equal(await db.modelProfile.count({ where: { providerConfigId: provider.id } }), 5);
    assert.equal(await page.locator('#default-model-text').textContent(), 'gpt-text-B');
    assert.equal(await page.locator('#default-model-image_gen').textContent(), 'gpt-image-B');
    for (const id of ['#default-model-image_gen', '#default-model-image_edit']) {
      await page.locator(id).click();
      await page.getByRole('option', { name: 'gpt-image-2', exact: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    await choose('#provider-history', `Second mock / ${provider.baseUrl}`);
    await page.getByRole('button', { name: '仅刷新模型列表', exact: true }).click();
    await page.getByText('模型列表已刷新并保存：共 5 个，图像生成 3 个。未发送文本、识图或生图请求。', { exact: true }).waitFor();
    assert.equal((await db.providerConfig.findFirst({ where: { isActive: true } })).id, provider.id, 'refreshing history does not switch the active service');
    assert.equal(probes, 1);
    await choose('#provider-history', `Browser mock / ${provider.baseUrl}`);
    await page.screenshot({ path: 'test-output/provider-browser/settings.png', fullPage: true });
    await choose('#provider-history', `Other origin mock / ${otherProvider.baseUrl}`);
    assert.equal(await page.locator('#provider-api-key').inputValue(), '', 'different service never inherits the previous key');
    assert.deepEqual(await readCredentials(), savedCredentials, 'viewing history does not switch runtime credentials');
    await choose('#provider-history', `Browser mock / ${provider.baseUrl}`);
    assert.equal(await page.locator('#provider-api-key').inputValue(), 'mock-browser-key');
    await page.locator('#provider-base-url').fill('https://new-mock.invalid/v1');
    assert.equal(await page.locator('#provider-api-key').inputValue(), '', 'editing the endpoint clears the draft key');
    await choose('#provider-history', `Other origin mock / ${otherProvider.baseUrl}`);
    await page.getByRole('button', { name: '切换为当前服务', exact: true }).click();
    await page.getByRole('button', { name: '当前使用中', exact: true }).waitFor();
    assert.deepEqual(await readCredentials(), { baseUrl: otherProvider.baseUrl, apiKey: '' }, 'activation never routes a new service through the old endpoint/key');
    const project = await db.project.create({ data: { name: 'Missing credential fixture', platform: 'general_ecommerce', style: 'generic_clean', assets: { create: { type: 'MAIN', fileName: 'fixture.png', filePath: 'fixture.png', mimeType: 'image/png' } } } });
    await page.route('**/api/files/fixture.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMssAAAAASUVORK5CYII=', 'base64') }));
    const briefUrl = `/api/projects/${project.id}/brief`;
    const missingResponse = page.waitForResponse(response => new URL(response.url()).pathname === briefUrl);
    await page.goto(`${url}/projects/${project.id}/configure`);
    assert.equal((await missingResponse).status(), 400);
    await page.getByText(/当前浏览器未提供此服务的 API Key/).waitFor();
    await page.getByRole('link', { name: '配置当前浏览器的密钥', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '重试分析', exact: true }).count(), 0);
    assert.equal((await db.project.findUniqueOrThrow({ where: { id: project.id } })).modelSnapshot, null);
    await page.screenshot({ path: 'test-output/provider-browser/missing-credentials.png', fullPage: true });
    // Verify the automatic first request carries the browser key after a full reload.
    await page.evaluate(baseUrl => localStorage.setItem('mxpage:provider-credentials:v1', JSON.stringify({ apiKey: 'restored-mock-key', baseUrl })), otherProvider.baseUrl);
    let restoredRequests = 0;
    await page.route(`**${briefUrl}`, route => {
      assert.equal(route.request().headers()['x-mxpage-api-key'], 'restored-mock-key');
      restoredRequests++;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { name: 'Mock cup', description: 'Mock only', visualDirection: '', uncertainties: [] } }) });
    });
    await page.reload();
    await page.getByText('历史预填，建议重新识别', { exact: true }).waitFor();
    assert.equal(restoredRequests, 1);
    assert.deepEqual(errors, []);
    console.log('PASS: serialized saves, failure rollback, image options, catalog refresh, auth failure credential preservation, service switching and brief credential errors/reload');
  } finally {
    await browser?.close();
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else server.kill('SIGTERM');
    await db.$disconnect(); fs.closeSync(log);
    for (const item of [dist, config]) {
      const resolved = path.resolve(item); if (path.dirname(resolved) !== process.cwd() || !item.includes(runId)) throw new Error('Invalid cache cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mxpage-provider-browser-')) throw new Error('Invalid fixture cleanup path');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
