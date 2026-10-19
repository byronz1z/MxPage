const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function checkSupplementalInput(browser, baseUrl, db) {
  // db/server are the regression runner's isolated fixtures, never the live app.
  const questions = [
    { text: '确认面料成分', fields: ['material'], options: ['棉', '聚酯纤维', '棉与聚酯纤维混纺'] },
    { text: '确认成衣尺寸，按胸围、衣长排列，单位为cm，均为约值。', fields: ['尺寸'], options: ['S：104/70；M：110/72', 'S：108/72；M：114/74', 'S：112/74；M：118/76'] },
    { text: '确认穿着场景', fields: ['scene'], options: ['城市日常通勤', '周末出游', '校园日常叠穿'] },
  ].map(question => ({ ...question, blocking: true, requiresImage: false }));
  const project = await db.project.create({ data: { name: '补充信息回归', platform: 'general_ecommerce', style: 'generic_clean' } });
  const checkpoint = { workflowVersion: 4, stage: 'WAITING_INPUT', images: [], answers: [], questions, imageReviews: {}, timings: {}, attempts: {}, requests: { INPUT_SUGGESTIONS: { state: 'completed', requestId: 'already-paid' } }, supplementalQuestionIssue: '旧校验误报：尺寸缺少单位' };
  const run = await db.detailRun.create({ data: { projectId: project.id, idempotencyKey: randomUUID(), status: 'WAITING_INPUT', stage: '请确认商品补充信息', input: {}, checkpoint } });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    const route = `${baseUrl}/api/projects/${project.id}/detail-runs`;
    await page.goto(`${baseUrl}/projects/${project.id}/editor`);
    await page.getByRole('heading', { name: questions[0].text, exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '生成具体选项', exact: true }).count(), 0);
    await page.reload();
    await page.getByText(questions[0].options[0], { exact: true }).click();
    await page.getByRole('button', { name: '确认，下一题', exact: true }).click();
    await page.getByText(questions[1].options[1], { exact: true }).click();
    await page.getByRole('button', { name: '暂时关闭补充信息', exact: true }).click();
    // Two completed poll cycles must preserve dismissal and the current answer.
    for (let i = 0; i < 2; i++) await page.waitForResponse(response => response.url().startsWith(route) && response.request().method() === 'GET');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: '打开补充信息', exact: true }).click();
    await page.getByRole('heading', { name: questions[1].text, exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: questions[1].options[1], exact: true }).isChecked(), true);
    await page.getByRole('button', { name: '确认，下一题', exact: true }).click();
    await page.getByText(questions[2].options[0], { exact: true }).click();
    let submissions = 0;
    await page.route(`${route}/${run.id}/answers`, async intercepted => {
      const body = intercepted.request().postDataJSON();
      assert.equal(body.responses.length, 3);
      assert.equal(body.responses[1].optionIndex, 1);
      submissions++;
      if (submissions === 1) return intercepted.fulfill({ status: 400, json: { success: false, error: { code: 'TEST_FAILURE', message: '模拟提交失败，答案应保留' } } });
      // Backend continuation is covered by the mock-provider recovery suite.
      await db.detailRun.update({ where: { id: run.id }, data: { status: 'CANCELED', stage: '测试已停止' } });
      await intercepted.fulfill({ status: 200, json: { success: true, data: {} } });
    });
    await page.getByRole('button', { name: '确认并继续生成', exact: true }).click();
    await page.getByText('模拟提交失败，答案应保留', { exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: questions[2].options[0], exact: true }).isChecked(), true);
    await page.getByRole('button', { name: '确认并继续生成', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(submissions, 2);
    assert.deepEqual(posts, [`/api/projects/${project.id}/detail-runs/${run.id}/answers`, `/api/projects/${project.id}/detail-runs/${run.id}/answers`]);

    // Truly incomplete candidates must explain the issue rather than show an
    // indistinguishable generation prompt after every explicit attempt.
    const invalid = structuredClone(checkpoint);
    invalid.questions[1].options = ['胸围、衣长', '肩宽、袖长', '胸围、肩宽'];
    await db.detailRun.update({ where: { id: run.id }, data: { status: 'WAITING_INPUT', checkpoint: invalid } });
    await page.reload();
    await page.getByRole('button', { name: '生成具体选项', exact: true }).waitFor();
    assert.match(await page.getByRole('dialog').getByRole('alert').innerText(), /具体模拟数值与单位/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ supplementalInput: true, sharedUnit: true, staleDiagnosticCleared: true, pollKeepsDismissed: true, answersPreserved: true, invalidReasonShown: true, implicitRequests: 0 }));
  } finally { await context.close(); }
};
