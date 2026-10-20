const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');
const { chromium } = require('playwright-core');
const checkUploadDrafts = require('./upload-drafts.cjs');
const checkSupplementalInput = require('./supplemental-input.cjs');
const checkAsyncImage = require('./async-image.cjs');
const checkOutputCounts = require('./output-counts.cjs');
const checkPromptReview = require('./prompt-review.cjs');
const promptFlow = process.argv.includes('--prompt-review-flow') ? require('./prompt-review-flow.cjs') : null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(200); } throw new Error(`Timeout: ${label}`); }

(async () => {
  process.chdir(path.resolve(__dirname, '../..'));
  fs.mkdirSync('test-output/browser-regression', { recursive: true });
  const runId = randomUUID();
  const dist = `.next-browser-${runId}`;
  const tsconfigFile = `.browser-tsconfig-${runId}.json`;
  fs.copyFileSync('tsconfig.json', tsconfigFile);
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mxpage-full-translation-'));
  const filename = path.join(directory, 'test.db');
  assert.equal(path.dirname(filename), directory);
  const sqlite = new DatabaseSync(filename);
  for (const folder of fs.readdirSync('prisma/migrations', { withFileTypes: true }).filter(x => x.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) sqlite.exec(fs.readFileSync(path.join('prisma/migrations', folder.name, 'migration.sql'), 'utf8'));
  sqlite.close();
  const databaseUrl = `file:${filename.replaceAll('\\', '/')}`;
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const png = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#c4ad89' } }).png().toBuffer();
  const pending = [], calls = [], forbidden = [];
  const provider = http.createServer(async (req, res) => {
    if (promptFlow) return promptFlow.respond(req, res, { pending, calls, forbidden });
    if (req.url !== '/v1/images/edits' || req.method !== 'POST') { forbidden.push(req.url); res.writeHead(500).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push(Buffer.concat(chunks));
    pending.push(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  await db.providerConfig.create({ data: { name: 'Isolated mock', baseUrl: providerUrl, apiKeyEncrypted: 'unused', isActive: true, models: { create: promptFlow ? promptFlow.models : { modelId: 'gpt-image-2.5-flare', label: 'Mock', capabilities: { image_edit: true, real_image_edit: true }, roles: {}, isDefaultImageEdit: true } } } });
  const log = fs.openSync('test-output/browser-regression/server.log', 'w');
  // Unique dist/config/database and an ephemeral port; never reuse the user's running service.
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', log, log], env: { ...process.env, DATABASE_URL: databaseUrl, STORAGE_ROOT: path.join(directory, 'storage'), NEXT_DIST_DIR: dist, MXPAGE_TEST_TSCONFIG: tsconfigFile, LOCK_BASE_URL: providerUrl, FORCED_API_BASE: providerUrl, FORCED_API_BASE_URL: providerUrl, NEXT_TELEMETRY_DISABLED: '1' } });
  let browser;
  const reports = [];
  try {
    await until(async () => { try { return (await fetch(`${baseUrl}/translate`)).ok; } catch { return false; } }, 'isolated server');
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : fs.existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }), headless: true, args: ['--no-proxy-server'] });
    if (promptFlow) {
      await promptFlow.check(browser, baseUrl, db, { providerUrl, pending, calls, png });
      assert.deepEqual(forbidden, []);
      return;
    }
    await checkPromptReview(browser, baseUrl, db);
    if (process.argv.includes('--prompt-review-only')) { assert.deepEqual(forbidden, []); assert.equal(calls.length, 0); return; }
    await checkOutputCounts(browser, baseUrl, db);
    if (process.argv.includes('--output-counts-only')) { assert.deepEqual(forbidden, []); assert.equal(calls.length, 0); return; }
    await checkSupplementalInput(browser, baseUrl, db);
    await checkAsyncImage(browser, baseUrl, db);
    await checkUploadDrafts(browser, baseUrl);
    for (const count of [1, 3]) {
      const context = await browser.newContext();
      await context.addInitScript(({ url }) => localStorage.setItem('mxpage:provider-credentials:v1', JSON.stringify({ apiKey: 'isolated-test-key', baseUrl: url })), { url: providerUrl });
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      let creates = 0, submits = 0;
      let creationLost = false, uploadLost = false;
      await page.route('**/api/projects', async route => {
        if (route.request().method() !== 'POST' || count !== 1 || creationLost) return route.continue();
        await route.fetch(); creationLost = true; await route.abort('failed');
      });
      await page.route('**/assets/upload', async route => {
        const body = route.request().postDataJSON();
        if (uploadLost || (count > 1 && !body.fileName.endsWith('-2.png'))) return route.continue();
        await route.fetch(); uploadLost = true; await route.abort('failed');
      });
      page.on('request', req => { if (req.method() === 'POST') { if (new URL(req.url()).pathname === '/api/projects') creates++; if (new URL(req.url()).pathname === '/api/detail-batches') submits++; } });
      const before = await db.project.count({ where: { platform: { not: '__mxpage_system_task__' } } });
      const startCalls = calls.length;
      await page.goto(`${baseUrl}/translate`);
      if (count > 1) await page.getByRole('button', { name: '多张翻译', exact: true }).click();
      await page.locator('input[type=file]').setInputFiles(Array.from({ length: count }, (_, i) => ({ name: `case-${count}-${i+1}.png`, mimeType: 'image/png', buffer: png })));
      await page.getByRole('button', { name: /开始翻译/ }).click();
      await page.waitForURL(/\/translate\/[\da-f-]+$/);
      const batchId = page.url().split('/').at(-1);
      await page.getByRole('heading', { name: '翻译进度与预览' }).waitFor();
      if (count === 1) {
        await until(() => creationLost, 'creation response lost');
        await page.locator('main').getByRole('button', { name: '继续上传 / 提交' }).waitFor();
        await page.reload();
      }
      await until(() => uploadLost, 'upload response lost');
      await page.locator('main').getByRole('button', { name: '继续上传 / 提交' }).waitFor();
      const draftProject = await db.project.findFirstOrThrow({ where: { modelSnapshot: { path: '$.translationBatchId', equals: batchId } } });
      const entryCheck = await context.newPage();
      await entryCheck.goto(`${baseUrl}/projects/${draftProject.id}/configure`);
      await entryCheck.waitForURL(`**/translate/${batchId}`);
      await entryCheck.close();
      await page.reload();
      await until(() => pending.length === Math.min(count, 2), 'image requests pending');
      await page.reload();
      await page.locator('main').getByText(`已翻译 0/${count} 张`, { exact: true }).first().waitFor();
      assert.equal(calls.length - startCalls, Math.min(count, 2), 'Running refresh must not resubmit');
      if (count > 1) {
        pending.shift()();
        await page.locator('main').getByAltText('译图 1', { exact: true }).waitFor();
        await page.locator('main').getByText(`已翻译 1/${count} 张`, { exact: true }).first().waitFor();
        await page.reload();
        await page.locator('main').getByAltText('译图 1', { exact: true }).waitFor();
        await page.locator('main').getByText(`已翻译 1/${count} 张`, { exact: true }).first().waitFor();
        await until(() => calls.length - startCalls === count, 'third image dispatched');
      }
      while (pending.length) pending.shift()();
      await page.locator('main').getByText(`已翻译 ${count}/${count} 张`, { exact: true }).first().waitFor();
      await page.locator('main').getByAltText(`译图 ${count}`, { exact: true }).waitFor();
      await page.reload();
      await page.locator('main').getByAltText(`译图 ${count}`, { exact: true }).waitFor();
      const batch = await (await fetch(`${baseUrl}/api/detail-batches/${batchId}`)).json();
      assert.equal(batch.data.items.length, 1); assert.equal(batch.data.status, 'SUCCESS');
      const id = batch.data.items[0].projectId;
      assert.equal(await db.project.count({ where: { platform: { not: '__mxpage_system_task__' } } }), before + 1);
      assert.equal(await db.detailRun.count({ where: { projectId: id } }), 0);
      assert.equal(calls.length - startCalls, count); assert.equal(creates, count === 1 ? 2 : 1); assert.ok(submits >= 1);
      assert.equal(await db.productAsset.count({ where: { projectId: id, type: 'DETAIL' } }), count);
      assert.equal((await db.generationTask.findMany({ where: { projectId: id, taskType: 'TRANSLATE_PAGE' } })).length, 1);
      await page.screenshot({ path: `test-output/browser-regression/translation-full-${count}.png`, fullPage: true });
      await page.getByRole('link', { name: '原图对照与长页预览', exact: true }).click();
      await page.getByRole('button', { name: '原图与译图对照', exact: true }).waitFor();
      assert.equal(await page.locator('main img').count(), count * 2);
      await until(() => page.locator('main img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0)), 'comparison image loading');
      const translatedCover = await page.locator('main img[alt^="译图："]').first().getAttribute('src');
      let projectReads = 0;
      page.on('request', req => { if (new URL(req.url()).pathname === `/api/projects/${id}` && req.method() === 'GET') projectReads++; });
      await page.waitForTimeout(3000);
      const settledReads = projectReads;
      await page.waitForTimeout(6000);
      assert.equal(projectReads, settledReads, 'Completed result stops polling');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await until(() => projectReads === settledReads + 1, 'focus refresh');
      await page.waitForTimeout(6000);
      assert.equal(projectReads, settledReads + 1, 'Focus refresh does not restart completed polling');
      await page.goto(`${baseUrl}/history?category=translation`);
      assert.equal(await page.locator(`main a[href="/projects/${id}/editor"]`).count(), 1);
      // Images can finish out of order. The cover follows section order/current selection, not completion time.
      const firstSection = await db.pageSection.findFirstOrThrow({ where: { projectId: id, currentImageAssetId: { not: null } }, orderBy: [{ order: 'asc' }, { id: 'asc' }], include: { currentImageAsset: true } });
      const sourceAsset = firstSection.currentImageAsset;
      assert.equal(translatedCover, `/api/files/${sourceAsset.filePath.replaceAll('\\', '/')}`);
      const thumbnail = page.locator(`main a[href="/projects/${id}/editor"] img`);
      await until(() => thumbnail.evaluate(image => image.complete && image.naturalWidth > 0), 'thumbnail preview');
      assert.equal(await thumbnail.getAttribute('src'), `/api/thumbnails/${sourceAsset.id}`, 'History uses dedicated result thumbnail');
      const thumbResponse = await page.request.get(`${baseUrl}/api/thumbnails/${sourceAsset.id}`);
      assert.equal(thumbResponse.headers()['content-type'], 'image/webp');
      assert.notEqual(await thumbnail.getAttribute('src'), translatedCover);
      assert.deepEqual(errors, []);
      reports.push({ count, batchId, projectId: id, creates, submits, modelCalls: calls.length - startCalls, runningRefresh: true, partialRefresh: count > 1, completedRefresh: true, preview: true, comparison: true, noDuplicates: true, completedPollingStopped: true, focusSync: true, translatedCover: true });
      console.log(JSON.stringify(reports.at(-1)));
      await context.close();
    }
    const dataContext = await browser.newContext();
    const dataPage = await dataContext.newPage(); dataPage.setDefaultTimeout(60000);
    const dataErrors = []; dataPage.on('pageerror', error => dataErrors.push(error.message));
    await dataPage.goto(`${baseUrl}/settings/data`);
    await dataPage.getByRole('heading', { name: '当前数据位置', exact: true }).waitFor();
    await dataPage.getByRole('button', { name: '创建备份', exact: true }).click();
    await dataPage.getByText('备份已完成，数据库和全部素材已保存。', { exact: true }).waitFor();
    const targetId = reports[0].projectId;
    const api = async (url, body, method = 'POST') => { const response = await dataPage.request.fetch(`${baseUrl}${url}`, { method, ...(body ? { data: body } : {}) }); return { status: response.status(), ...await response.json() }; };
    const originalCount = await db.productAsset.count();
    assert.equal((await api(`/api/projects/${targetId}`, undefined, 'DELETE')).success, true);
    await dataPage.reload();
    await dataPage.getByRole('button', { name: '还原作品', exact: true }).click();
    await dataPage.getByText('作品已还原，原图、结果与版本记录均保留。', { exact: true }).waitFor();
    assert.equal(await db.productAsset.count(), originalCount);
    const invalid = await api(`/api/projects/${targetId}/assets/upload`, { type: 'MAIN', fileName: 'bad.png', mimeType: 'image/png', base64Data: Buffer.from('broken image').toString('base64') });
    assert.equal(invalid.status, 400); assert.equal(await db.productAsset.count(), originalCount);
    const beforeDelete = await db.project.findUniqueOrThrow({ where: { id: targetId }, include: { sections: true, assets: true } });
    await db.project.delete({ where: { id: targetId } });
    await dataPage.reload();
    await dataPage.getByRole('button', { name: '校验并预览恢复', exact: true }).first().click();
    await dataPage.getByRole('button', { name: '恢复缺失作品', exact: true }).click();
    await dataPage.getByText(/恢复完成，补回 1 个作品/).waitFor();
    const afterRestore = await db.project.findUniqueOrThrow({ where: { id: targetId }, include: { sections: true, assets: true } });
    assert.deepEqual(afterRestore.assets, beforeDelete.assets); assert.deepEqual(afterRestore.sections, beforeDelete.sections);
    await dataPage.goto(`${baseUrl}/projects/${targetId}/editor`);
    await until(() => dataPage.locator('main img').evaluateAll(imgs => imgs.length === 2 && imgs.every(img => img.complete && img.naturalWidth > 0)), 'restored original and translated preview');
    assert.deepEqual(dataErrors, []);
    console.log(JSON.stringify({ dataManagement: true, backup: true, trashRestore: true, backupRestore: true, invalidUploadRejected: true, originalComparisonRetained: true }));
    await dataContext.close();
    assert.deepEqual(forbidden, []);
    fs.writeFileSync('test-output/browser-regression/translation-full-flow-results.json', JSON.stringify(reports, null, 2));
  } catch (error) {
    if (browser) for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) await page.screenshot({ path: `test-output/browser-regression/failure-${index}.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    while (pending.length) pending.shift()();
    await browser?.close();
    if (process.platform === 'win32') await new Promise(resolve => { const kill = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); kill.on('exit', resolve); kill.on('error', resolve); });
    else { try { process.kill(-server.pid, 'SIGTERM'); } catch {} }
    if (server.exitCode === null && server.signalCode === null) await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(5000)]);
    if (process.platform !== 'win32' && server.exitCode === null && server.signalCode === null) {
      try { process.kill(-server.pid, 'SIGKILL'); } catch {}
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
    }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await db.$disconnect(); fs.closeSync(log);
    // Only remove directories generated by this run after the child process has stopped.
    if (path.dirname(path.resolve(dist)) !== process.cwd() || !dist.startsWith('.next-browser-')) throw new Error('Invalid test cache path');
    fs.rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(tsconfigFile, { force: true });
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('mxpage-full-translation-')) throw new Error('Invalid fixture path');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log('Browser regression artifacts: test-output/browser-regression');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
