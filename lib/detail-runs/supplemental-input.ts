import { z } from "zod";
import { confirmedAnswerCopyRules } from "./customer-copy";

export const missingFieldSchema = z.object({
  field: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(500),
  blocking: z.boolean(),
  // Older saved plans may not have suggestions; never fabricate fallback answers locally.
  options: z.array(z.string().trim().min(1).max(200)).max(3).default([]).describe("三个可直接选用的商品模拟答案；规格题每项须包含对应的具体数值与单位，不能只列参数名称"),
});

export type StoredSupplementalQuestion = {
  text: string;
  blocking: boolean;
  requiresImage: boolean;
  fields?: string[];
  options?: string[];
};
export type SupplementalQuestion = StoredSupplementalQuestion & {
  id: string;
  fields: string[];
  options: string[];
};

// These are processing instructions, not answers about the product. Do not display or accept them.
export function isConcreteSupplementalOption(option: string) {
  const text = option.trim();
  return Boolean(text) && !/按.{0,12}(?:现有|已有|已提供).{0,12}(?:继续|处理)|(?:仅|只)使用.{0,20}(?:信息|事实)|暂不(?:展示|确定|提供|标注)|暂(?:无|缺).{0,10}(?:信息|参数)|沿用现有|系统.{0,8}判断|自行填写|自定义|^其他$|^不确定/.test(text);
}

function quantitativeOptionIssue(question: Pick<SupplementalQuestion, "text" | "fields" | "options">) {
  const subject = [...question.fields, question.text].join(" ");
  const rules = [
    { name: "尺寸", field: /尺寸|直径|高度|长宽|宽度|dimensions?|\bsize\b/i, value: /\d+(?:\.\d+)?\s*(?:mm|cm|m|inches?|inch|in|毫米|厘米|公分|米|英寸|寸)(?![a-z])/i },
    { name: "重量", field: /净重|重量|weight/i, value: /\d+(?:\.\d+)?\s*(?:kg|mg|g|oz|lb|千克|公斤|毫克|克|斤)(?![a-z])/i },
    { name: "容量", field: /容量|容积|capacity|volume/i, value: /\d+(?:\.\d+)?\s*(?:mL|L|cc|毫升|升)(?![a-z])/i },
  ];
  const missing = rules.filter(rule => rule.field.test(subject) && question.options.some(option => !rule.value.test(option)));
  return missing.length ? `「${question.text}」的每个候选都需要包含${missing.map(rule => rule.name).join("、")}的具体模拟数值与单位，不能只提供参数名称或用途。` : null;
}

export function incompleteSupplementalEstimates(answers: Array<{ question: string; fields: string[]; source: string; answer: string }> = []) {
  return answers.filter(answer => answer.source === "option" && quantitativeOptionIssue({ text: answer.question, fields: answer.fields, options: [answer.answer] }));
}

export const supplementalSuggestionsSchema = z.object({ questions: z.array(z.object({
  text: z.string().trim().min(1).max(700),
  fields: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  options: z.array(z.string().trim().min(1).max(200)).length(3).describe("具体模拟答案；规格必须给出数值与单位，组合问题的每个选项必须回答全部字段"),
})).length(3) });

export function supplementalQuestionsFromFields(fields: z.infer<typeof missingFieldSchema>[]) {
  return normalizeSupplementalQuestions(fields.map(field => ({ text: field.question, fields: [field.field], options: field.options, blocking: field.blocking, requiresImage: false })));
}

/** Normalize model output only. Missing or generic choices require model suggestions, never fixed filler. */
export function normalizeSupplementalQuestions(stored: StoredSupplementalQuestion[] = []): SupplementalQuestion[] {
  const entries = stored.filter(question => question.text.trim()).map(question => ({ ...question, fields: question.fields?.length ? question.fields : [question.text] }));
  return entries.map((question, index) => {
    const options = [...new Set((question.options || []).map(option => option.trim()).filter(isConcreteSupplementalOption))].slice(0, 3);
    return { ...question, id: `question-${index + 1}`, options };
  });
}

export function supplementalQuestionsReady(questions: SupplementalQuestion[]) {
  return questions.length === 3 && questions.every(question => question.options.length === 3 && new Set(question.options).size === 3 && question.options.every(isConcreteSupplementalOption) && !quantitativeOptionIssue(question));
}

export function supplementalQuestionIssues(questions: SupplementalQuestion[], requiredFields: string[]) {
  const covered = new Set(questions.flatMap(question => question.fields));
  const numericIssue = questions.map(quantitativeOptionIssue).find(Boolean);
  if (numericIssue) return numericIssue;
  if (!supplementalQuestionsReady(questions)) return "需要三个问题，每题提供三个不同的具体候选答案。";
  if (requiredFields.some(field => !covered.has(field))) return "补充问题未包含全部待确认信息。";
  return null;
}

// A content fingerprint prevents an old open dialog from answering a changed question set.
// This is a revision marker only; the server still checks every ID and option against its checkpoint.
export function supplementalQuestionSetId(questions: SupplementalQuestion[]) {
  const source = JSON.stringify(questions.map(({ id, text, fields, options, blocking, requiresImage }) => ({ id, text, fields, options, blocking, requiresImage })));
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const responseSchema = z.discriminatedUnion("mode", [
  z.object({ questionId: z.string(), mode: z.literal("option"), optionIndex: z.number().int().min(0).max(2) }),
  z.object({ questionId: z.string(), mode: z.literal("custom"), customText: z.string().trim().min(1).max(1200) }),
]);
export const supplementalSubmissionSchema = z.object({
  questionSetId: z.string(),
  responses: z.array(responseSchema).length(3),
});
export type SupplementalSubmission = z.infer<typeof supplementalSubmissionSchema>;
export type SupplementalSelection = { mode?: "option" | "custom"; optionIndex?: number; customText?: string };

export function buildSupplementalSubmission(questions: SupplementalQuestion[], selections: Record<string, SupplementalSelection>): SupplementalSubmission | null {
  if (!supplementalQuestionsReady(questions)) return null;
  const responses = questions.map(question => {
    const selected = selections[question.id];
    if (selected?.mode === "custom") return { questionId: question.id, mode: "custom", customText: selected.customText?.trim() };
    if (selected?.mode === "option") return { questionId: question.id, mode: "option", optionIndex: selected.optionIndex };
    return null;
  });
  const parsed = supplementalSubmissionSchema.safeParse({ questionSetId: supplementalQuestionSetId(questions), responses });
  return parsed.success ? parsed.data : null;
}

export function resolveSupplementalSubmission(questions: SupplementalQuestion[], raw: unknown) {
  if (!supplementalQuestionsReady(questions)) throw new Error("请先为商品生成具体候选答案，再进行确认。");
  const parsed = supplementalSubmissionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("请为每张卡片选择一个答案，或填写自定义内容（最多 1200 字）。");
  const body = parsed.data;
  if (body.questionSetId !== supplementalQuestionSetId(questions)) throw new Error("补充问题已更新，请刷新后重新确认。");
  const ids = new Set(body.responses.map(response => response.questionId));
  if (ids.size !== questions.length || body.responses.length !== questions.length || questions.some(question => !ids.has(question.id))) throw new Error("请完整回答当前显示的所有卡片。");
  return questions.map(question => {
    const response = body.responses.find(item => item.questionId === question.id)!;
    return { question: question.text, fields: question.fields, source: response.mode, basis: response.mode === "custom" ? "user_provided" as const : "model_estimate" as const, answer: response.mode === "custom" ? response.customText : question.options[response.optionIndex] };
  });
}

export const supplementalInputInstructions = `补充信息交互规则：
详情页任务中，尺寸、重量、容量、材质及使用条件等商品信息缺失时，必须列入 missingFields，不能因为可以制作外观展示页就省略确认。只要存在待补充字段，程序都会先暂停请用户确认；blocking=false 不能授权跳过弹窗或直接出图。
需要用户确认时，将 missingFields 组织为恰好三个问题组，每题 options 恰好三个不同的具体候选答案。结合该商品图片、描述、类目和用户要求自主推断，让用户能直接选择确认；不合适则用户自行填写，不要把“自行填写”放入 options。
禁止用处理方式凑选项，例如“按现有信息继续”“暂不展示”“仅使用已知信息”“由系统判断”“沿用现有定位”。不要用全品类通用答案或固定问卷代替针对当前商品的推断。
缺少数值时，按用户要求结合商品外观、比例与常见规格生成三组合理的模拟数据，候选数值用“约”标识，用户确认前一律不当作事实。不要退回“直径和高度”“水箱容量、整机尺寸与净重”“请提供具体参数”这样的字段名或填写指令。
例如一款小型加湿器可给出“水箱约300 mL；尺寸约12×12×10 cm；净重约350 g”这类完整候选，并按实际商品另拟两组合理组合。示例只是答案结构，不能把这组数值固定套用到其他商品。组合问题的每个选项必须一次给全所有字段的答案，不能让用户选择参数类型后再补数值。
场景题要写具体场景，例如“卧室床头的睡前氛围”“茶席旁的冥想布置”“餐桌烛光晚餐”，不要只写“场景展示”或“自用”。根据商品自主选择问题，不要照抄示例。
只有1–2项关键缺失时，补充与该商品密切相关的用途、人群或卖点表达问题；问题更多时合并相关字段为三个问题，保留所有待确认信息。已有明确答案不要再次追问。
材质题给具体材质方案；场景题给具体人群与摆放场景；操作题给具体的操作步骤，不要只写“可提供操作说明”。认证、检测结果、安全保证和售后承诺不能伪造为现有事实。对有真实标注的参数保留原值，模拟值不得覆盖用户已给的实测信息。
answers 和 confirmedSupplementalAnswers 是用户选用的唯一补充来源。选择和填空互斥；确认后不重复追问，完整保留已有事实与详情内容。basis=model_estimate 表示用户选用的模拟方案，可用于当前设计稿，数值保留“约”，不得宣称实测或验证；basis=user_provided 表示用户自行填写。未选中的候选不得进入 facts、规格或最终文案。没有用户确认的估算不能自行写入，用户填“不确定”的字段继续保持未知。
${confirmedAnswerCopyRules}`;
