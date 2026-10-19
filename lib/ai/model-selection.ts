export const modelRoleFields = {
  analysis: "isDefaultAnalysis", planning: "isDefaultPlanning", hero: "isDefaultHeroImage",
  detail: "isDefaultDetailImage", edit: "isDefaultImageEdit",
} as const;
export type ModelRole = keyof typeof modelRoleFields;
export type SelectableModel = {
  modelId: string; capabilities: unknown; isAvailable?: boolean;
  isDefaultAnalysis?: boolean; isDefaultPlanning?: boolean; isDefaultHeroImage?: boolean;
  isDefaultDetailImage?: boolean; isDefaultImageEdit?: boolean;
};
export function selectModel(models: SelectableModel[], role: ModelRole, preferred?: string | null, needsVision = false) {
  const label = { analysis: "图像识别", planning: "文本生成", hero: "主图生成", detail: "详情图生成", edit: "图像编辑" }[role];
  const model = preferred ? models.find(m => m.modelId === preferred) : models.find(m => m[modelRoleFields[role]]);
  if (!model) throw new Error(`请在设置中选择有效的${label}模型${preferred ? `：${preferred}` : ""}。`);
  if (model.isAvailable === false) throw new Error(`所选模型不可用：${model.modelId}`);
  const capabilities = (model.capabilities || {}) as Record<string, unknown>;
  if ((role === "edit" && capabilities.real_image_edit === false) || (["hero", "detail"].includes(role) && capabilities.real_image_gen === false)) throw new Error(`所选模型 ${model.modelId} 不支持真实${label}，请修改模型设置。`);
  const required = role === "analysis" ? ["text", "vision"] : role === "planning" ? ["text", ...(needsVision ? ["vision"] : [])] : [role === "edit" ? "image_edit" : "image_gen"];
  if (required.some(key => !capabilities[key])) throw new Error(`所选模型 ${model.modelId} 不支持本操作需要的能力：${required.join("、")}。请修改模型设置。`);
  return model.modelId;
}
