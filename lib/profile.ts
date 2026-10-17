import { z } from "zod";

export const PROFILE_STORAGE_KEY = "mxpage:profile:v1";
export const profileSchema = z.object({
  name: z.string().trim().min(1, "请填写显示名称").max(40, "显示名称最多 40 个字符"),
  username: z.string().trim().regex(/^[a-zA-Z0-9_.-]{2,30}$/, "用户名需为 2–30 位字母、数字、下划线、点或短横线"),
  avatar: z.string().max(400_000, "头像文件过大").regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "请上传有效的头像图片").nullable(),
});
export type UserProfile = z.infer<typeof profileSchema>;
export const defaultProfile: UserProfile = { name: "创作者", username: "mxpage", avatar: null };

export function readProfile(raw: string | null): UserProfile {
  try {
    const parsed = profileSchema.safeParse(JSON.parse(raw ?? "null"));
    return parsed.success ? parsed.data : defaultProfile;
  } catch { return defaultProfile; }
}
