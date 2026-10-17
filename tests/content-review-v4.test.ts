import assert from "node:assert/strict";
import test from "node:test";
import { commerceContentModuleIds } from "../lib/ai/prompts/ecommerce-system";
import { applyContentPlacements, contentCoverageSchema, normalizeContentCoverage, prepareContentCoverage, prepareReadableCopy, restorePlannedCopy, validateContentCoverage, validatePlannedCopy, type ContentCoverage } from "../lib/detail-runs/content-review-v4";
import { normalizeTypesetting, validateExactTypesetting, wrapExactText } from "../lib/detail-runs/typesetting-v4";

const sections = [{ kind: "HERO", copy: "商品首图" }, { kind: "DETAIL", copy: "场景、细节与已知信息" }];
const coverage = (): ContentCoverage => commerceContentModuleIds.map(module => ({
  module, status: ["specifications", "trust", "usage"].includes(module) ? "needs_input" : "covered",
  sectionIndexes: ["specifications", "trust", "usage"].includes(module) ? [] : [1],
  reason: ["specifications", "trust", "usage"].includes(module) ? "未提供对应参数、承诺或说明，需要用户补充。" : "已安排相关图文内容。",
}));

test("limited source facts can leave explicit gaps without inventing parameters or removing other modules", () => {
  assert.ok(contentCoverageSchema.safeParse(coverage()).success);
  assert.deepEqual(validateContentCoverage(sections, coverage()), []);
});

test("missing or duplicate coverage records are accepted for local advisory normalization", () => {
  const missing = coverage().slice(1);
  assert.ok(contentCoverageSchema.safeParse(missing).success);
  assert.match(validateContentCoverage(sections, missing).join(""), /需求与痛点/);
  const duplicate = coverage(); duplicate[1] = { ...duplicate[0] };
  assert.match(validateContentCoverage(sections, duplicate).join(""), /需求与痛点.*卖点与证据/);
});

test("coverage normalization preserves full content and evidence, merges duplicates and never fabricates missing facts", () => {
  const p = misplacedPlan();
  p.contentCoverage.push({ ...p.contentCoverage[0], sectionIndexes: [0, 999] });
  p.contentCoverage = p.contentCoverage.filter(entry => entry.module !== "usage");
  const { plan: fixed, warnings } = prepareContentCoverage(p);
  assert.equal(fixed.contentCoverage.length, 8);
  assert.deepEqual(fixed.facts, p.facts); assert.deepEqual(fixed.missingFields, p.missingFields);
  assert.deepEqual(fixed.sections.slice(0, 2), p.sections.slice(0, 2));
  for (const source of p.sections.slice(0, 2)) assert.ok(fixed.sections.some(section => section.kind === "DETAIL" && section.copy.includes(source.copy) && source.evidence.every(id => section.evidence.includes(id))));
  assert.equal(fixed.contentCoverage.find(entry => entry.module === "usage")?.status, "needs_input");
  assert.ok(!fixed.contentCoverage.some(entry => entry.sectionIndexes.includes(999)));
  assert.ok(warnings.length);
  assert.deepEqual(prepareContentCoverage(fixed).plan, fixed, "Resume does not append content again");
});

test("overfull or already rendered pages keep their content and get advisory coverage notes", () => {
  for (const allowPlacement of [true, false]) {
    const p = misplacedPlan();
    if (allowPlacement) for (const section of p.sections.filter(s => s.kind === "DETAIL")) section.copy = "完整正文".repeat(400);
    const { plan: fixed, warnings } = prepareContentCoverage(p, allowPlacement);
    assert.deepEqual(fixed.sections, p.sections);
    assert.ok(warnings.some(warning => warning.includes("头图")));
    assert.equal(fixed.contentCoverage[0].status, "partial");
  }
});

test("headings, paraphrases, punctuation and wraps remain model-owned with no blocking text check", () => {
  const copy = "卧室床头的居家摆放\n原有正文。\n容量：350 mL；尺寸：12×12×10 cm。";
  const text = "卧室床头居家场景\n原有正文!\n容量:350 mL,尺寸:12×12×10 cm!";
  const direction = { sectionIndex: 0, prompt: "Bedside", textBlocks: [{ text, role: "body", lines: ["old"] }] };
  const result = prepareReadableCopy([{ copy }], [direction]);
  assert.deepEqual(result.sections, [direction]);
  const normalized = normalizeTypesetting(result.sections[0].textBlocks);
  assert.equal(normalized[0].lines.join(""), text);
  assert.deepEqual(validateExactTypesetting(normalized), []);
});

test("missing parameters, size-table cells and severely shortened body are recovered without model retries", () => {
  for (const copy of ["清晨好风景\n容量：350 mL，重量280 g。", "尺码 | 胸围 | 衣长\nS | 88 | 60\nM | 92 | 62", "完整买家场景、使用说明与产品细节。".repeat(6)]) {
    const result = prepareReadableCopy([{ copy }], [{ sectionIndex: 0, prompt: "Page", textBlocks: [{ text: "标题", role: "title" }] }]);
    assert.equal(result.sections[0].textBlocks.map(block => block.text).join("\n"), copy);
    assert.ok(result.warnings.some(warning => warning.includes("自动补齐")));
    assert.deepEqual(prepareReadableCopy([{ copy }], result.sections).sections, result.sections);
  }
  assert.throws(() => prepareReadableCopy([{ copy: "a" }, { copy: "b" }], [{ sectionIndex: 0, prompt: "Page", textBlocks: [] }]), /分镜位置无法对应/);
});

test("English units, decimal dimensions and original spacing survive wrapping as single tokens", () => {
  const text = "规格：12.5 × 12 × 10 cm；容量350 mL，净重280 g。";
  const lines = wrapExactText(text, 8);
  assert.equal(lines.join(""), text);
  for (const token of ["12.5 × 12 × 10 cm", "350 mL", "280 g"]) assert.ok(lines.some(line => line.includes(token)), token);
});

test("hero-only claims, empty copy and nonexistent pages do not count as detail coverage", () => {
  const heroOnly = coverage(); heroOnly[0].sectionIndexes = [0];
  assert.match(validateContentCoverage(sections, heroOnly).join(""), /不能只在轮播头图/);
  const nonexistent = coverage(); nonexistent[0].sectionIndexes = [9];
  assert.match(validateContentCoverage(sections, nonexistent).join(""), /第 10 页不存在/);
  assert.match(validateContentCoverage([{ kind: "DETAIL", copy: " " }], coverage().map(item => item.status === "covered" ? { ...item, sectionIndexes: [0] } : item)).join(""), /没有实际文案/);
});

test("deferring or excluding a module requires a reason", () => {
  const incomplete = coverage(); incomplete[4].reason = " ";
  assert.match(validateContentCoverage(sections, incomplete).join(""), /具体原因/);
});

test("known parameters with missing specifications stay partially covered and keep their original gaps", () => {
  const value = coverage();
  const specs = value.find(entry => entry.module === "specifications")!;
  specs.sectionIndexes = [1]; specs.reason = "已列颜色与形态，仍缺尺寸与重量。";
  const normalized = normalizeContentCoverage(sections, value);
  assert.equal(normalized.find(entry => entry.module === "specifications")?.status, "partial");
  assert.equal(specs.status, "needs_input", "Do not mutate the cached plan during read-only display");
  assert.deepEqual(normalized.find(entry => entry.module === "specifications")?.sectionIndexes, [1]);
  assert.equal(normalized.find(entry => entry.module === "specifications")?.reason, specs.reason);
  assert.deepEqual(validateContentCoverage(sections, normalized), []);
  assert.equal(normalized.filter(entry => entry.status === "covered").length, 5);
});

test("partial coverage still requires real DETAIL copy and a specific gap; invalid references are never normalized away", () => {
  for (const indexes of [[0], [99]]) {
    const value = coverage(); value[4].sectionIndexes = indexes;
    assert.equal(normalizeContentCoverage(sections, value)[4].status, "needs_input");
    assert.ok(validateContentCoverage(sections, value).length);
  }
  const partial = coverage(); partial[4] = { ...partial[4], status: "partial", sectionIndexes: [0], reason: " " };
  assert.match(validateContentCoverage(sections, partial).join(""), /不能只在轮播头图.*具体资料/);
});

function misplacedPlan() {
  return { facts: ["米白色"], missingFields: [{ field: "高度", question: "高度？", blocking: false }],
    sections: [
      { kind: "HERO", copy: "需求与场景\n玄关与餐桌的陈设参考。", objective: "场景", evidence: ["source-photo"] },
      { kind: "HERO", copy: "卖点\n米白色｜浅色点缀", objective: "卖点", evidence: ["user_description"] },
      { kind: "DETAIL", copy: "原有细节正文", objective: "细节", evidence: ["source-photo"] },
      { kind: "DETAIL", copy: "原有收口正文", objective: "收口", evidence: ["source-photo"] },
    ],
    contentCoverage: coverage().map(entry => ({ ...entry, sectionIndexes: entry.status !== "covered" ? [] : entry.module === "selling_points" ? [1] : ["need", "scenarios"].includes(entry.module) ? [0] : [2] })),
  };
}

test("placement repair carries full HERO copy and evidence into DETAIL without rewriting, deleting or adding pages", () => {
  const original = misplacedPlan();
  const repaired = applyContentPlacements(original, { placements: [
    { module: "need", detailIndex: 2 }, { module: "scenarios", detailIndex: 2 }, { module: "selling_points", detailIndex: 3 },
  ] });
  assert.deepEqual(validateContentCoverage(repaired.sections, repaired.contentCoverage), []);
  assert.equal(repaired.sections.length, original.sections.length);
  assert.deepEqual(repaired.sections.slice(0, 2), original.sections.slice(0, 2));
  assert.equal(repaired.sections[2].copy, original.sections[2].copy + "\n" + original.sections[0].copy);
  assert.equal(repaired.sections[3].copy, original.sections[3].copy + "\n" + original.sections[1].copy);
  assert.deepEqual(repaired.sections[3].evidence, ["source-photo", "user_description"]);
  assert.deepEqual(repaired.facts, original.facts); assert.deepEqual(repaired.missingFields, original.missingFields);
  assert.equal(original.sections[2].copy, "原有细节正文");
});

test("placement repair rejects fabricated pages, duplicate modules and overfull copy instead of simplifying it", () => {
  const p = misplacedPlan();
  const placements = [{ module: "need" as const, detailIndex: 2 }, { module: "scenarios" as const, detailIndex: 2 }, { module: "selling_points" as const, detailIndex: 3 }];
  for (const index of [0, 20]) assert.throws(() => applyContentPlacements(p, { placements: placements.map(item => ({ ...item, detailIndex: index })) }), /已有详情页/);
  assert.throws(() => applyContentPlacements(p, { placements: [placements[0], placements[0], placements[2]] }), /只指定/);
  p.sections[2].copy = "完整正文".repeat(400);
  assert.throws(() => applyContentPlacements(p, { placements }), /信息过多/);
});

test("art direction may rewrap complete copy but cannot reduce the page to its title", () => {
  const plan = [{ copy: "浅棕马克杯\n早餐时光，搭配日常桌面。\n容量：350 ml" }];
  const full = [{ sectionIndex: 0, textBlocks: [{ text: "浅棕\n马克杯" }, { text: "早餐时光，搭配日常桌面。" }, { text: "容量：350 ml" }] }];
  assert.deepEqual(validatePlannedCopy(plan, full), []);
  assert.equal(validatePlannedCopy(plan, [{ sectionIndex: 0, textBlocks: [{ text: "浅棕马克杯" }] }]).length, 2);
});

test("parameter labels, size-chart columns and cells, punctuation and units survive art direction", () => {
  const plan = [{ copy: "参数：容量350 ml，重量280 g。\n尺码 胸围 衣长\nS 88 cm 60 cm\nM 92 cm 62 cm" }];
  const full = { sectionIndex: 0, textBlocks: plan[0].copy.split("\n").map(text => ({ text })) };
  assert.deepEqual(validatePlannedCopy(plan, [full]), []);
  for (const text of [plan[0].copy.replace("350 ml", "350 g"), plan[0].copy.replace("衣长", ""), plan[0].copy.replace("62 cm", ""), plan[0].copy.replace("，", ",")]) {
    assert.ok(validatePlannedCopy(plan, [{ sectionIndex: 0, textBlocks: [{ text }] }]).length > 0);
  }
});

test("copy must remain on its planned page even if art direction returns a different order", () => {
  const plan = [{ copy: "主图完整文案" }, { copy: "细节完整文案" }];
  assert.deepEqual(validatePlannedCopy(plan, [{ sectionIndex: 1, textBlocks: [{ text: plan[1].copy }] }, { sectionIndex: 0, textBlocks: [{ text: plan[0].copy }] }]), []);
  assert.ok(validatePlannedCopy(plan, [{ sectionIndex: 0, textBlocks: [{ text: plan[1].copy }] }, { sectionIndex: 1, textBlocks: [{ text: plan[0].copy }] }]).length > 0);
});

test("a rephrased scene heading is restored without changing the visual layout or duplicating titles", () => {
  const copy = "卧室床头的居家摆放\n原有正文。\n容量：350 mL；尺寸：12×12×10 cm。";
  const blocks = copy.split("\n").map((text, index) => ({ text: index ? text : "卧室床头居家场景", role: index ? "body" : "title", x: 7, y: 6 + index * 30, width: 86, fontSize: 24, lines: ["stale"] }));
  const original = [{ sectionIndex: 0, prompt: "Warm light; title 卧室床头居家场景", textBlocks: blocks }];
  const [fixed] = restorePlannedCopy([{ copy }], original);
  assert.equal(fixed.textBlocks.map(block => block.text).join("\n"), copy);
  assert.equal(fixed.textBlocks[0].y, blocks[0].y);
  assert.equal(fixed.textBlocks.length, blocks.length);
  assert.equal(fixed.prompt, "Warm light; title 卧室床头的居家摆放");
  assert.equal(original[0].textBlocks[0].text, "卧室床头居家场景", "Saved source is not mutated");
  assert.deepEqual(validatePlannedCopy([{ copy }], [fixed]), []);
  assert.deepEqual(validateExactTypesetting(normalizeTypesetting(fixed.textBlocks)), []);
  assert.deepEqual(restorePlannedCopy([{ copy }], [fixed]), [fixed], "Repair is idempotent on resume");
});

test("missing parameter rows and changed units recover the complete canonical copy even with fewer layout slots", () => {
  const copy = "尺码表\n尺码 胸围 衣长\nS 88 cm 60 cm\nM 92 cm 62 cm\n容量：350 ml，重量280 g。";
  const result = restorePlannedCopy([{ copy }], [{ sectionIndex: 0, prompt: "规格：容量350 g", textBlocks: [{ text: "尺码表", role: "title" }, { text: "容量350 g", role: "body" }] }]);
  assert.deepEqual(validatePlannedCopy([{ copy }], result), []);
  assert.equal(result[0].textBlocks.map(block => block.text).join("\n"), copy);
  assert.ok(!result[0].prompt.includes("容量350 g"));
  const empty = restorePlannedCopy([{ copy }], [{ sectionIndex: 0, prompt: "Warm page", textBlocks: [] }]);
  assert.deepEqual(validatePlannedCopy([{ copy }], empty), []);
  assert.throws(() => restorePlannedCopy([{ copy }, { copy }], [result[0], result[0]]), /编号重复/);
});
