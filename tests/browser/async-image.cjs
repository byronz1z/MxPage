const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function checkAsyncImage(browser, baseUrl, db) {
  const project = await db.project.create({ data: { name: '异步图片恢复测试', platform: 'general_ecommerce', style: 'generic_clean' } });
  const section = await db.pageSection.create({ data: { projectId: project.id, sectionKey: 'hero-0', order: 0, type: 'HERO', title: '已提交的图片', goal: '测试', copy: '测试', visualPrompt: 'test' } });
  const checkpoint = { workflowVersion: 4, stage: 'PARTIAL', images: [{ sectionId: section.id, title: section.title, state: 'uncertain', correctionCount: 0 }], answers: [], imageReviews: {}, attempts: {}, timings: {}, requests: { [`GENERATE:${section.id}`]: { state: 'uncertain', requestId: 'saved-request', upstreamTask: { id: 'saved-upstream-task', protocol: 'evolink_tasks', status: 'pending' } } } };
  const run = await db.detailRun.create({ data: { projectId: project.id, idempotencyKey: randomUUID(), status: 'PARTIAL', stage: '查询暂未完成', input: {}, checkpoint } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') mutations.push(request.url()); });
    await page.goto(`${baseUrl}/projects/${project.id}/editor`);
    await page.getByText('1 张图片已有上游任务编号；继续时查询原结果，不重新提交这些图片。', { exact: true }).waitFor();
    assert.equal(await page.getByText('重试结果不确定的请求，可能产生额外费用', { exact: true }).count(), 0);
    assert.equal(mutations.length, 0);
    let resumeBody;
    await page.route(`**/detail-runs/${run.id}/resume`, async route => {
      resumeBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, json: { success: true, data: {} } });
    });
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/detail-runs/${run.id}/resume`)),
      page.getByRole('button', { name: '继续未完成部分', exact: true }).click(),
    ]);
    assert.equal(resumeBody?.retryUncertain, false);
    assert.equal(mutations.length, 1);
    checkpoint.requests[`GENERATE:${section.id}`].upstreamTask.status = 'failed';
    await db.detailRun.update({ where: { id: run.id }, data: { checkpoint } });
    await page.reload();
    await page.getByText('重试结果不确定的请求，可能产生额外费用', { exact: true }).waitFor();
    assert.equal(await page.getByText(/张图片已有上游任务编号/).count(), 0);
    const task = await db.generationTask.create({ data: { projectId: project.id, sectionId: section.id, taskType: 'GENERATE', status: 'FAILED', inputPayload: {}, outputPayload: { imageRecovery: { model: 'mock-original' }, upstreamImageTask: { id: 'mock-receipt', protocol: 'evolink_tasks', status: 'pending' } } } });
    await page.route(`**/api/tasks/${task.id}/query-image`, route => route.fulfill({ status: 200, json: { success: true, data: { outputPayload: { imageUrl: '/api/files/mock-recovered.png' } } } }));
    await page.goto(`${baseUrl}/tasks`);
    await page.getByRole('button', { name: '查询原结果（不重新生成）', exact: true }).click();
    await page.getByRole('link', { name: '查看恢复图片', exact: true }).waitFor();
    assert.equal(mutations.filter(url => url.endsWith('/query-image')).length, 1);
    await page.route('**/api/providers/image-capabilities?*', route => route.fulfill({ status: 200, json: { success: true, data: [{ modelId: 'mock-document', label: 'Mock documented model', evidence: 'documented', routeVerified: false, qualities: ['auto'], backgrounds: ['auto'], formats: ['png'], sizes: ['auto'], maxReferences: 1, mask: false, compression: false, moderation: false }] } }));
    await page.goto(`${baseUrl}/translate`);
    await page.getByText(/Mock documented model/).waitFor();
    await page.getByLabel('图像画质', { exact: false }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['自动 · 由模型决定']);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ asyncImageRecovery: true, queryWithoutPaidRetry: true, noImplicitRequests: true }));
  } finally { await context.close(); }
};
