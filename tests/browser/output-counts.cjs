const assert = require('node:assert/strict');

module.exports = async function checkOutputCounts(browser, baseUrl, db) {
  const project = await db.project.create({ data: {
    name: '数量边界回归', platform: 'general_ecommerce', style: 'generic_clean',
    modelSnapshot: { creationBrief: { name: '数量边界回归', description: '模拟商品', visualDirection: '', uncertainties: [] }, previewConfig: { heroImageCount: 0, detailSectionCount: 2 } },
  } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [], submissions = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`**/api/projects/${project.id}/detail-runs`, route => {
      if (route.request().method() !== 'POST') return route.continue();
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: 'mock-counts-run', status: 'PENDING' } }) });
    });
    const hero = () => page.locator('label').filter({ hasText: /^头图数量/ }).getByRole('combobox');
    const detail = () => page.locator('label').filter({ hasText: /^详情图数量/ }).getByRole('combobox');
    async function choose(locator, value) {
      await locator.click();
      await page.getByRole('option', { name: String(value), exact: true }).click();
    }
    await page.goto(`${baseUrl}/projects/${project.id}/configure`);
    await page.getByRole('button', { name: '确认并生成 2 张图片', exact: true }).waitFor();
    await hero().getByText('0', { exact: true }).waitFor();
    assert.equal(await hero().textContent(), '0');
    assert.equal(await detail().textContent(), '2');
    await choose(detail(), 0);
    await page.getByRole('alert').filter({ hasText: '主图和详情图不能同时为 0' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认并生成 0 张图片', exact: true }).isDisabled(), true);
    assert.equal(submissions.length, 0);
    await choose(hero(), 1);
    assert.equal(await page.getByRole('button', { name: '确认并生成 1 张图片', exact: true }).isEnabled(), true);
    await choose(detail(), 1);
    await choose(hero(), 0);
    await page.getByRole('button', { name: '确认并生成 1 张图片', exact: true }).click();
    await page.waitForURL(`**/projects/${project.id}/editor`);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].heroCount, 0);
    assert.equal(submissions[0].detailCount, 1);
    const saved = await db.project.findUniqueOrThrow({ where: { id: project.id } });
    assert.equal(saved.modelSnapshot.previewConfig.heroImageCount, 0);
    assert.equal(saved.modelSnapshot.previewConfig.detailSectionCount, 1);
    await page.goto(`${baseUrl}/projects/${project.id}/configure`);
    await page.reload();
    await page.getByRole('button', { name: '确认并生成 1 张图片', exact: true }).waitFor();
    await hero().getByText('0', { exact: true }).waitFor();
    assert.equal(await hero().textContent(), '0');
    assert.equal(await detail().textContent(), '1');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'test-output/browser-regression/output-counts.png', fullPage: true });
    console.log('PASS: zero hero/detail selection, empty-count warning, disabled submit, exact payload and reload persistence');
  } finally { await context.close(); }
};
