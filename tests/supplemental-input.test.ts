import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSupplementalSubmission, incompleteSupplementalEstimates, missingFieldSchema, normalizeSupplementalQuestions, resolveSupplementalSubmission, supplementalQuestionSetId, supplementalQuestionsFromFields, supplementalQuestionsReady, supplementalQuestionIssues } from "../lib/detail-runs/supplemental-input";

const fields = [
  { field: "material", question: "商品材质是什么？", blocking: true, options: ["陶瓷", "玻璃", "不锈钢"] },
  { field: "purpose", question: "这款杯子适合盛什么？", blocking: true, options: ["日常喝茶", "早餐咖啡", "办公室热水"] },
  { field: "scene", question: "主要展示什么场景？", blocking: false, options: ["日常茶席", "办公室休息", "礼赠展示"] },
];
const questions = supplementalQuestionsFromFields(fields);
const selected = () => Object.fromEntries(questions.map(question => [question.id, { mode: "option" as const, optionIndex: 0, customText: "未选中的旧填空，不能采用" }]));

test("only concrete model options are used; old or generic options are not padded with canned answers", () => {
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0].options, fields[0].options);
  const legacy = supplementalQuestionsFromFields([missingFieldSchema.parse({ field: "weight", question: "重量？", blocking: true })]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].text, "重量？");
  assert.deepEqual(legacy[0].options, []);
  assert.equal(supplementalQuestionsReady(legacy), false);
  assert.deepEqual(normalizeSupplementalQuestions(legacy), legacy);
  const duplicated = normalizeSupplementalQuestions([{ text: "用途？", blocking: false, requiresImage: false, options: ["自用", "自用", "  "] }]);
  assert.deepEqual(duplicated[0].options, ["自用"]);
  assert.equal(supplementalQuestionsReady(duplicated), false);
  const generic = normalizeSupplementalQuestions([{ text: "用途？", blocking: true, requiresImage: false, options: ["按现有信息继续", "暂不展示", "仅使用图片和描述中已确认的信息"] }]);
  assert.deepEqual(generic[0].options, []);
  assert.equal(buildSupplementalSubmission(generic, {}), null);
  assert.throws(() => resolveSupplementalSubmission(generic, {}), /具体候选/);
});

test("overflow is preserved for model regrouping; three questions must cover every missing field", () => {
  const input = [...fields, ...fields.map(field => ({ ...field, field: `${field.field}-extra`, question: `${field.question}（补充）` }))];
  const cards = supplementalQuestionsFromFields(input);
  assert.equal(cards.length, 6);
  assert.deepEqual(cards.flatMap(card => card.fields), input.map(field => field.field));
  for (const field of input) assert.ok(cards.some(card => card.text.includes(field.question)));
  assert.equal(supplementalQuestionsReady(cards), false);
  assert.ok(supplementalQuestionIssues(questions, input.map(field => field.field))?.includes("全部"));
  assert.equal(supplementalQuestionIssues(questions, fields.map(field => field.field)), null);
});

test("option mode discards hidden custom text; custom mode discards the previous option", () => {
  const selections = selected();
  const payload = buildSupplementalSubmission(questions, selections)!;
  assert.ok(!JSON.stringify(payload).includes("旧填空"));
  assert.deepEqual(resolveSupplementalSubmission(questions, payload).map(answer => answer.answer), fields.map(field => field.options[0]));
  const custom = buildSupplementalSubmission(questions, { ...selections, [questions[1].id]: { mode: "custom", optionIndex: 2, customText: "  实测容量 280 mL。  " } })!;
  assert.equal(custom.responses[1].mode, "custom");
  assert.ok(!("optionIndex" in custom.responses[1]));
  assert.equal(resolveSupplementalSubmission(questions, custom)[1].answer, "实测容量 280 mL。");
  assert.equal(resolveSupplementalSubmission(questions, custom)[1].basis, "user_provided");
  assert.equal(resolveSupplementalSubmission(questions, custom)[0].basis, "model_estimate");
  assert.equal(buildSupplementalSubmission(questions, { ...selections, [questions[1].id]: { mode: "custom", customText: "  " } }), null);
  assert.equal(buildSupplementalSubmission(questions, {}), null);
});

test("specification choices must answer every requested quantity with values and units", () => {
  const numeric = { ...questions[0], text: "规格数据？", fields: ["水箱容量、整机尺寸与净重"], options: ["水箱容量、整机尺寸与净重", "容量和尺寸", "仅尺寸"] };
  const candidate = [numeric, ...questions.slice(1)];
  assert.equal(supplementalQuestionsReady(candidate), false);
  assert.match(supplementalQuestionIssues(candidate, numeric.fields)!, /尺寸、重量、容量/);
  const specific = ["水箱约300 mL；尺寸约12×12×10 cm；净重约350 g", "水箱约400毫升；尺寸约14×14×12厘米；净重约0.5公斤", "水箱约500 mL；尺寸约16×16×14 cm；净重约650 g"];
  numeric.options = specific;
  assert.equal(supplementalQuestionsReady(candidate), true);
  const payload = buildSupplementalSubmission(candidate, Object.fromEntries(candidate.map(q => [q.id, { mode: "option", optionIndex: 1 }])))!;
  const answer = resolveSupplementalSubmission(candidate, payload)[0];
  assert.equal(answer.answer, specific[1]); assert.equal(answer.basis, "model_estimate");
  numeric.options = ["水箱约300 mL；净重约350 g", specific[1], specific[2]];
  assert.equal(supplementalQuestionsReady(candidate), false, "A complete capacity value cannot mask a missing dimension");
  assert.equal(buildSupplementalSubmission(candidate, {}), null);
});

test("size tables can declare a shared unit in the question and preserve it on submission", () => {
  const options = ["S：胸围104、衣长70；M：胸围110、衣长72", "S：胸围108、衣长72；M：胸围114、衣长74", "S：胸围112、衣长74；M：胸围118、衣长76"];
  for (const declaration of ["单位为cm", "单位：厘米", "单位（cm）", "单位均为 cm", "units: cm"]) {
    const candidate = [{ ...questions[0], text: `尺码与成衣尺寸，${declaration}，数值均为约值。`, fields: ["尺码与成衣尺寸"], options }, ...questions.slice(1)];
    assert.equal(supplementalQuestionIssues(candidate, ["尺码与成衣尺寸"]), null, declaration);
    const payload = buildSupplementalSubmission(candidate, selected())!;
    const answers = resolveSupplementalSubmission(candidate, payload);
    assert.equal(answers[0].answer, `${options[0]}（单位：${declaration.includes("厘米") ? "厘米" : "cm"}）`);
    assert.equal(answers[0].basis, "model_estimate");
    assert.deepEqual(incompleteSupplementalEstimates(answers), []);
    assert.deepEqual(candidate[0].options, options, "Validation never rewrites saved options");
    const custom = buildSupplementalSubmission(candidate, { ...selected(), [candidate[0].id]: { mode: "custom", customText: "尚未测量" } })!;
    assert.equal(resolveSupplementalSubmission(candidate, custom)[0].answer, "尚未测量");
  }
});

test("shared units do not excuse absent numbers, unrelated quantities or mixed units", () => {
  const card = { ...questions[0], text: "成衣尺寸，单位为cm。", fields: ["尺寸"], options: ["胸围104、衣长70", "胸围110、衣长72", "胸围116、衣长74"] };
  for (const invalid of [
    { ...card, options: ["胸围、衣长", ...card.options.slice(1)] },
    { ...card, text: "成衣尺寸，参考款衣长70 cm。" },
    { ...card, text: "成衣尺寸，单位为kg。" },
    { ...card, options: ["重量350 g", ...card.options.slice(1)] },
    { ...card, fields: ["尺寸", "重量"], text: "尺寸与重量，单位为cm。" },
    { ...card, options: ["胸围约104 cm", "胸围、衣长", "胸围、肩宽"] },
  ]) assert.equal(supplementalQuestionsReady([invalid, ...questions.slice(1)]), false);
});

test("server resolves saved choices and rejects blank, invalid, incomplete, duplicate or stale submissions", () => {
  const payload = buildSupplementalSubmission(questions, selected())!;
  const forged = { ...payload, responses: payload.responses.map(response => ({ ...response, answer: "伪造答案", customText: "隐藏旧答案" })) };
  assert.deepEqual(resolveSupplementalSubmission(questions, forged).map(answer => answer.answer), fields.map(field => field.options[0]));
  assert.throws(() => resolveSupplementalSubmission(questions, { ...payload, responses: [payload.responses[0], payload.responses[0], payload.responses[2]] }), /所有卡片/);
  assert.throws(() => resolveSupplementalSubmission(questions, { ...payload, responses: payload.responses.slice(1) }), /每张卡片/);
  assert.throws(() => resolveSupplementalSubmission(questions, { ...payload, responses: [{ questionId: questions[0].id, mode: "option", optionIndex: 7 }, ...payload.responses.slice(1)] }), /每张卡片/);
  assert.throws(() => resolveSupplementalSubmission(questions, { ...payload, responses: [{ questionId: questions[0].id, mode: "custom", customText: " " }, ...payload.responses.slice(1)] }), /每张卡片/);
  const changed = questions.map((question, index) => index ? question : { ...question, text: "新的问题？" });
  assert.notEqual(supplementalQuestionSetId(questions), supplementalQuestionSetId(changed));
  assert.throws(() => resolveSupplementalSubmission(changed, payload), /问题已更新/);
  assert.equal(supplementalQuestionSetId(questions), supplementalQuestionSetId(normalizeSupplementalQuestions(JSON.parse(JSON.stringify(questions)))));
});
