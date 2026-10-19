import { z } from "zod";
import { commerceContentModuleIds, commerceContentModuleLabels } from "@/lib/ai/prompts/ecommerce-system";
import type { V4TextBlock } from "./typesetting-v4";

export const contentCoverageSchema = z.array(z.object({
  module: z.enum(commerceContentModuleIds),
  status: z.enum(["covered", "partial", "needs_input", "not_applicable"]).describe("covered=已安排完整已知内容；partial=已安排部分内容但仍缺资料；needs_input=无可安排内容；not_applicable=不适用"),
  sectionIndexes: z.array(z.number().int().nonnegative()).max(30).describe("sections 数组从0开始的全套下标，不是DETAIL内的相对下标。covered/partial须包含DETAIL；needs_input/not_applicable必须为[]"),
  reason: z.string().max(300),
})).max(40);
export type ContentCoverage = z.infer<typeof contentCoverageSchema>;

// Older plans used needs_input for both missing and partially supplied facts.
// Preserve the existing page references and gaps without claiming full coverage.
export function normalizeContentCoverage(sections: Array<{ kind: string; copy: string }>, coverage: ContentCoverage): ContentCoverage {
  return coverage.map(entry => entry.status === "needs_input" && entry.reason.trim() && entry.sectionIndexes.length > 0
    && entry.sectionIndexes.every(index => sections[index]?.copy.trim())
    && entry.sectionIndexes.some(index => sections[index]?.kind === "DETAIL")
    ? { ...entry, status: "partial" } : entry);
}

export const contentCoverageInstructions = [
  "先完成DETAIL的完整购买决策叙事，再提炼HERO摘要。需求、卖点、场景不能只放在轮播头图；少屏合并模块，不删减已有文案。",
  "contentCoverage 的 sectionIndexes 是 sections 全套从0开始的下标，严格按 sectionSlots 的编号与 kind 安排，不能使用DETAIL内相对编号。",
  "covered 表示已知内容已完整安排；partial 表示已有部分内容落页，同时 reason 列明仍缺的资料。这两种状态都必须引用真实承载内容的DETAIL。",
  "needs_input 表示没有可安排的内容，not_applicable 表示本任务不适用；二者 sectionIndexes 必须为[]，reason 必须说明具体缺口或范围依据。",
  "例如已列出颜色与形态但缺尺寸：specifications=partial，引用参数DETAIL，reason说明缺尺寸，missingFields保留缺口；不能填needs_input又引用已安排页面。",
  "coverage 必须与 sections[].copy 的实际内容对应，不能仅修改下标或把缺失模块改成不适用来通过检查。",
].join("\n");

export function validateContentCoverage(sections: Array<{ kind: string; copy: string }>, coverage: ContentCoverage) {
  const issues: string[] = [];
  for (const module of commerceContentModuleIds) {
    const entries = coverage.filter(entry => entry.module === module);
    const label = commerceContentModuleLabels[module];
    if (entries.length !== 1) { issues.push(`内容覆盖.${module}：${label}必须有且只有一条覆盖记录。`); continue; }
    const entry = entries[0];
    if (entry.status === "covered" || entry.status === "partial") {
      if (!entry.sectionIndexes.length) issues.push(`内容覆盖.${module}：${label}没有对应页面。`);
      for (const index of entry.sectionIndexes) {
        if (!sections[index]) issues.push(`内容覆盖.${module}：第 ${index + 1} 页不存在。`);
        else if (!sections[index].copy.trim()) issues.push(`内容覆盖.${module}：第 ${index + 1} 页没有实际文案，不能仅靠标签宣称覆盖。`);
      }
      if (sections.some(section => section.kind === "DETAIL") && !entry.sectionIndexes.some(index => sections[index]?.kind === "DETAIL")) {
        issues.push(`内容覆盖.${module}：${label}需要落实到详情页，不能只在轮播头图中出现。`);
      }
    } else if (!entry.reason.trim()) issues.push(`内容覆盖.${module}：必须说明待补充资料或不适用的具体原因。`);
    if (entry.status === "partial" && !entry.reason.trim()) issues.push(`内容覆盖.${module}：部分已安排时必须说明仍缺少的具体资料。`);
    if (["needs_input", "not_applicable"].includes(entry.status) && entry.sectionIndexes.length) issues.push(`内容覆盖.${module}：待补充或不适用项不能同时标记为已安排页面。`);
  }
  return issues;
}

export const contentPlacementSchema = z.object({ placements: z.array(z.object({
  module: z.enum(commerceContentModuleIds),
  detailIndex: z.number().int().nonnegative().describe("承接该模块完整文案的DETAIL在sections中的全套下标"),
})).min(1).max(commerceContentModuleIds.length) });

type CoveragePlan = { sections: Array<{ kind: string; copy: string; objective: string; evidence: string[] }>; contentCoverage?: ContentCoverage };

export function heroOnlyContentModules(plan: CoveragePlan) {
  if (!plan.sections.some(section => section.kind === "DETAIL")) return [];
  return (plan.contentCoverage || []).filter(entry => ["covered", "partial"].includes(entry.status)
    && entry.sectionIndexes.length > 0
    && entry.sectionIndexes.every(index => plan.sections[index]?.kind === "HERO" && plan.sections[index].copy.trim()));
}

/** Coverage is advisory metadata. Carry existing copy into DETAIL when possible;
 * never invent missing content or stop paid work over labels/indices alone. */
export function prepareContentCoverage<T extends CoveragePlan>(plan: T, placeContent = true) {
  const warnings: string[] = [];
  const sections = plan.sections.map(section => ({ ...section, evidence: [...section.evidence] }));
  const contentCoverage: ContentCoverage = commerceContentModuleIds.map(module => {
    const entries = (plan.contentCoverage || []).filter(entry => entry.module === module);
    if (!entries.length) {
      warnings.push("部分内容未提供覆盖说明，已保留完整草稿，可在预览后核对。");
      return { module, status: "needs_input", sectionIndexes: [], reason: "未提供覆盖说明，待核对实际页面。" };
    }
    const indexes = [...new Set(entries.flatMap(entry => entry.sectionIndexes))].filter(index => sections[index]?.copy.trim());
    const entry = { ...entries[0], sectionIndexes: indexes, reason: [...new Set(entries.map(item => item.reason).filter(Boolean))].join("；") };
    if (entries.length > 1 || entries.some(item => item.sectionIndexes.some(index => !indexes.includes(index)))) warnings.push("已整理重复或无效的内容页码，保留有效页面与文案。");
    if (["needs_input", "not_applicable"].includes(entry.status) && indexes.length) {
      entry.status = "partial";
      entry.reason ||= "已有部分内容落页，其余信息可在预览后补充。";
    }
    if (["covered", "partial"].includes(entry.status) && !indexes.length) {
      entry.status = "needs_input";
      entry.reason ||= "尚未找到对应详情内容，请在预览后核对。";
    }
    if (entry.status !== "covered") entry.reason ||= "部分信息待核对。";
    return entry;
  });
  for (const entry of heroOnlyContentModules({ sections, contentCoverage })) {
    let placed = true;
    for (const sourceIndex of entry.sectionIndexes) {
      const source = sections[sourceIndex];
      const candidates = sections.flatMap((target, index) => {
        if (target.kind !== "DETAIL") return [];
        const existing = new Set(target.copy.split(/\r?\n/).map(line => line.trim()));
        const additions = source.copy.split(/\r?\n/).filter(line => line.trim() && !existing.has(line.trim()));
        const copy = [target.copy, ...additions].filter(Boolean).join("\n");
        const evidence = [...new Set([...target.evidence, ...source.evidence])];
        return copy.length <= 1600 && evidence.length <= 12 && (placeContent || additions.length === 0) ? [{ index, copy, evidence, added: additions.join("\n").length }] : [];
      }).sort((a, b) => a.added - b.added || a.copy.length - b.copy.length || a.index - b.index);
      const selected = candidates[0];
      if (!selected) { placed = false; continue; }
      sections[selected.index] = { ...sections[selected.index], copy: selected.copy, evidence: selected.evidence };
      entry.sectionIndexes = [...new Set([...entry.sectionIndexes, selected.index])];
    }
    if (placed) warnings.push("已将轮播头图中的完整内容同步到详情页，无需额外模型请求。");
    else {
      entry.status = "partial";
      entry.reason = "部分内容仍在头图中，已有文案和图片保留，请在预览后核对详情覆盖。";
      warnings.push(entry.reason);
    }
  }
  for (const entry of contentCoverage) if (entry.status === "needs_input" || entry.status === "partial") warnings.push(`${commerceContentModuleLabels[entry.module]}：${entry.reason}`);
  return { plan: { ...plan, sections, contentCoverage }, warnings: [...new Set(warnings)] };
}

// The model chooses placement only. Code carries the canonical copy and its
// evidence into DETAIL; it cannot rewrite facts, remove text or add pages.
export function applyContentPlacements<T extends CoveragePlan>(plan: T, result: z.infer<typeof contentPlacementSchema>): T {
  const modules = heroOnlyContentModules(plan);
  if (result.placements.length !== modules.length || new Set(result.placements.map(item => item.module)).size !== modules.length) throw new Error("内容安排修复必须为每个缺失模块指定且只指定一张详情页。");
  const sections = plan.sections.map(section => ({ ...section, evidence: [...section.evidence] }));
  const coverage = (plan.contentCoverage || []).map(entry => ({ ...entry, sectionIndexes: [...entry.sectionIndexes] }));
  for (const placement of result.placements) {
    const entry = modules.find(item => item.module === placement.module);
    const target = sections[placement.detailIndex];
    if (!entry || target?.kind !== "DETAIL") throw new Error("内容安排修复只能将缺失模块安排到已有详情页。");
    for (const index of entry.sectionIndexes) {
      const source = plan.sections[index];
      const lines = new Set(target.copy.split(/\r?\n/).map(line => line.trim()));
      const additions = source.copy.split(/\r?\n/).filter(line => line.trim() && !lines.has(line.trim()));
      target.copy = [target.copy, ...additions].filter(Boolean).join("\n");
      target.evidence = [...new Set([...target.evidence, ...source.evidence])];
    }
    if (target.copy.length > 1600 || target.evidence.length > 12) throw new Error(`内容安排修复后第 ${placement.detailIndex + 1} 张信息过多，请调整内容分配；完整文案已保留。`);
    const mapped = coverage.find(item => item.module === placement.module)!;
    mapped.sectionIndexes.push(placement.detailIndex);
  }
  const issues = validateContentCoverage(sections, coverage);
  if (issues.length) throw new Error(issues.join("；"));
  return { ...plan, sections, contentCoverage: coverage };
}

const compact = (text: string) => text.replace(/\s+/gu, "");

// Used only for lost parameters or severely shortened body copy. Recover from
// the saved plan without another request or a second, contradictory title.
export function restorePlannedCopy<D extends { sectionIndex: number; prompt: string; textBlocks: V4TextBlock[] }>(sections: Array<{ copy: string }>, directions: D[]) {
  if (directions.length !== sections.length || new Set(directions.map(item => item.sectionIndex)).size !== sections.length
    || directions.some(item => !Number.isInteger(item.sectionIndex) || !sections[item.sectionIndex])) throw new Error("视觉分镜编号重复或缺失，未发起图片请求。");
  return directions.map(direction => {
    const canonical = sections[direction.sectionIndex].copy;
    const lines = canonical.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const actual = compact(direction.textBlocks.map(block => block.text).join("\n"));
    if (lines.every(line => actual.includes(compact(line)))) return direction;
    const slots = direction.textBlocks.length ? direction.textBlocks : [{ text: "", role: "body", x: 7, y: 8, width: 86, fontSize: 18, lineHeight: 1.4, align: "left" }];
    const count = Math.min(slots.length, lines.length);
    let offset = 0;
    const replacements = new Map<string, string>();
    const textBlocks = slots.slice(0, count).map((slot, index) => {
      const take = index === 0 && count > 1 && /title|headline/.test(slot.role) ? 1 : Math.ceil((lines.length - offset) / (count - index));
      const text = lines.slice(offset, offset += take).join("\n");
      if (slot.text && slot.text !== text) replacements.set(slot.text, text);
      return { ...slot, text, lines: undefined };
    });
    // Remove discarded model wording from embedded prompt copy as well.
    for (const slot of slots.slice(count)) if (slot.text) replacements.set(slot.text, "");
    const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length).map(text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const prompt = pattern ? direction.prompt.replace(new RegExp(pattern, "gu"), text => replacements.get(text)!) : direction.prompt;
    return { ...direction, prompt, textBlocks };
  });
}

const readable = (text: string) => text.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const parameterLine = (text: string) => /\d\s*(?:mm|cm|kg|mg|ml|hz|w|v|a|g|l|毫米|厘米|千克|公斤|克|毫升|升|瓦|伏|安|小时|分钟|%|℃|°C)(?![a-z])/i.test(text)
  || /(?:尺寸|规格|型号|材质|成分|颜色|容量|重量|功率|电压|尺码|胸围|衣长)\s*[：:|｜]/.test(text)
  || /尺码.*(?:胸围|衣长|腰围|肩宽)/.test(text);

/** Paraphrases, headings, punctuation and line breaks never fail the run.
 * Recover only empty/severely shortened copy or missing parameter rows. */
export function prepareReadableCopy<D extends { sectionIndex: number; prompt: string; textBlocks: V4TextBlock[] }>(sections: Array<{ copy: string }>, directions: D[]) {
  if (directions.length !== sections.length || new Set(directions.map(item => item.sectionIndex)).size !== sections.length
    || directions.some(item => !Number.isInteger(item.sectionIndex) || !sections[item.sectionIndex])) throw new Error("部分图片的分镜位置无法对应，草稿已保留，请核对页面数量后继续。");
  const warnings: string[] = [];
  const prepared = directions.map(direction => {
    const canonical = sections[direction.sectionIndex].copy;
    const actual = readable(direction.textBlocks.map(block => block.text).join("\n"));
    const source = readable(canonical);
    const lines = canonical.split(/\r?\n/);
    const hasParameterTable = lines.some(line => parameterLine(line) && /[|｜]/.test(line));
    const lostParameters = lines.filter(line => parameterLine(line) || (hasParameterTable && /[|｜]/.test(line)))
      .some(line => !actual.includes(readable(line)));
    const lostBody = source.length > 0 && (!actual.length || (source.length >= 60 && actual.length < source.length * 0.6));
    if (lostParameters || lostBody) {
      warnings.push(`第 ${direction.sectionIndex + 1} 页${lostParameters ? "参数信息" : "正文"}已从规划自动补齐，任务继续执行。`);
      const [restored] = restorePlannedCopy([{ copy: canonical }], [{ ...direction, sectionIndex: 0 }]);
      return { ...restored, sectionIndex: direction.sectionIndex };
    }
    if (source && !actual.includes(source)) warnings.push(`第 ${direction.sectionIndex + 1} 页采用了润色后的文案，可在预览中核对。`);
    return direction;
  });
  return { sections: prepared, warnings };
}

// Planning copy is canonical. The art director may split it into blocks and
// line-wrap it, but must not remove body copy, labels, parameter cells or units.
export function validatePlannedCopy(sections: Array<{ copy: string }>, directions: Array<{ sectionIndex: number; textBlocks: Array<{ text: string }> }>) {
  return sections.flatMap((section, index) => {
    const direction = directions.find(item => item.sectionIndex === index);
    if (!direction) return [`sections[${index}]：缺少视觉分镜。`];
    const actual = compact(direction.textBlocks.map(block => block.text).join("\n"));
    return section.copy.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line =>
      actual.includes(compact(line)) ? [] : [`sections[${index}].textBlocks：遗漏或改写规划文案「${line.slice(0, 100)}」。请保留正文、标注、参数与单位。`]);
  });
}
