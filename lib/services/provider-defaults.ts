import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { selectModel, modelRoleFields, type ModelRole } from "@/lib/ai/model-selection";
export const defaultRoles = { analysisModelId: "analysis", planningModelId: "planning", heroImageModelId: "hero", detailImageModelId: "detail", imageEditModelId: "edit" } as const;
export const providerDefaultsSchema = z.object({
  analysisModelId: z.string().nullable().optional(), planningModelId: z.string().nullable().optional(),
  heroImageModelId: z.string().nullable().optional(), detailImageModelId: z.string().nullable().optional(), imageEditModelId: z.string().nullable().optional(),
  textProtocol: z.enum(["auto", "chat_completions", "responses", "anthropic_messages", "gemini_native"]).optional(),
  structuredOutputMode: z.enum(["json_schema", "json_object", "prompt_json"]).optional(),
}).strict();
export async function saveProviderDefaults(id: string, raw: unknown) {
  const input = providerDefaultsSchema.parse(raw);
  return prisma.$transaction(async tx => {
    await tx.providerConfig.update({ where: { id }, data: { updatedAt: new Date(), ...(input.textProtocol ? { textProtocol: input.textProtocol } : {}), ...(input.structuredOutputMode ? { structuredOutputMode: input.structuredOutputMode } : {}) } });
    const models = await tx.modelProfile.findMany({ where: { providerConfigId: id } });
    for (const [key, role] of Object.entries(defaultRoles) as Array<[keyof typeof defaultRoles, ModelRole]>) {
      if (!(key in input)) continue;
      const selected = input[key];
      if (selected) selectModel(models, role, selected);
      const flag = modelRoleFields[role];
      await tx.modelProfile.updateMany({ where: { providerConfigId: id }, data: { [flag]: false } });
      if (selected) await tx.modelProfile.update({ where: { providerConfigId_modelId: { providerConfigId: id, modelId: selected } }, data: { [flag]: true } });
    }
    const provider = await tx.providerConfig.findUniqueOrThrow({ where: { id }, include: { models: true } });
    const { apiKeyEncrypted: _secret, ...safe } = provider;
    return safe;
  });
}
