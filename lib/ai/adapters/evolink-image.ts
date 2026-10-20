import { setTimeout as delay } from "node:timers/promises";
import type { ImageGenerationRequest, ImageGenerationResult } from "../provider-client";
import type { ImageContract } from "../image-protocol";
import { evoLinkImageParameters } from "../image-parameters";

type ResponseBody = { ok: boolean; status: number; body: string };
type Transport = (url: string, init: RequestInit, timeoutMs: number) => Promise<ResponseBody>;
const api = "https://api.evolink.ai/v1";
const upload = "https://files-api.evolink.ai/api/v1/files/upload/base64";

// EvoLink's documented GPT Image contract uses one POST (including references),
// followed only by GETs. The task ID must survive a poll failure or process exit.
export async function generateEvoLinkImage(
  input: ImageGenerationRequest & { mask?: string }, request: Transport, contract?: ImageContract,
): Promise<ImageGenerationResult> {
  const deadline = Date.now() + (input.timeoutMs ?? 180000);
  let task = input.upstreamTask;
  const remaining = () => {
    input.signal?.throwIfAborted();
    const ms = deadline - Date.now();
    if (ms <= 0) throw Object.assign(new Error(task
      ? "图片任务仍在上游处理，已保存任务编号。继续任务只查询结果，不会重新提交生图。"
      : "图片服务响应超时，结果暂未确认，请勿重复提交。"), { code: task ? "IMAGE_TASK_PENDING" : "IMAGE_REQUEST_TIMEOUT" });
    return ms;
  };
  const jsonRequest = async (url: string, init: RequestInit) => {
    const response = await request(url, { ...init, signal: input.signal, redirect: "error" }, remaining());
    if (!response.ok) throw Object.assign(new Error(`图片服务请求失败（${response.status}，${new URL(url).pathname}）。${task ? "上游任务编号已保存，继续时只查询结果。" : "请检查服务接口与模型配置。"}`), {
      status: response.status,
      code: !task && [404, 405].includes(response.status) ? "IMAGE_ENDPOINT_UNAVAILABLE" : "IMAGE_REQUEST_FAILED",
    });
    return JSON.parse(response.body);
  };
  const publicUrl = (value: unknown): string => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) throw new Error("图像服务未返回可用的图片地址，任务已保留。");
    return value;
  };
  const referenceUrl = async (image: string) => {
    if (/^https?:\/\//i.test(image)) return publicUrl(image);
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(image)) throw new Error("参考图格式无效，请重新上传图片。");
    const result = await jsonRequest(upload, { method: "POST", body: JSON.stringify({ base64_data: image }) });
    if (result.success !== true) throw new Error("参考图上传失败，尚未提交生图任务。请检查文件服务配额。 ");
    return publicUrl(result.data?.file_url);
  };
  if (!task) {
    const parameters = evoLinkImageParameters(input, contract);
    const imageUrls: string[] = [];
    for (const image of input.referenceImages ?? []) imageUrls.push(await referenceUrl(image));
    const maskUrl = input.mask ? await referenceUrl(input.mask) : undefined;
    // Uploads can take time. Recheck stop/ownership immediately before billing.
    await input.beforeSubmit?.();
    const payload = await jsonRequest(`${api}/images/generations`, { method: "POST", body: JSON.stringify({
      ...parameters,
      ...(imageUrls.length ? { image_urls: imageUrls } : {}),
      ...(maskUrl ? { mask_url: maskUrl } : {}),
    }) });
    if (typeof payload.id !== "string" || !payload.id.trim()) throw new Error("图像服务未返回任务编号，结果不确定；请先查看服务端任务，避免重复计费。");
    task = { protocol: "evolink_tasks", id: payload.id, status: "pending" };
    await input.onUpstreamTask?.(task);
  }
  if (task.protocol !== "evolink_tasks" || !task.id || task.status === "failed") throw new Error("上游图片任务已失败，请明确重试后再提交新任务。");
  while (true) {
    let result: any;
    try { result = await jsonRequest(`${api}/tasks/${encodeURIComponent(task.id)}`, { method: "GET" }); }
    catch (cause) {
      input.signal?.throwIfAborted();
      if ((cause as { code?: string })?.code === "IMAGE_TASK_PENDING") throw cause;
      throw Object.assign(new Error("图片结果查询失败，上游任务编号已保存。请查询原任务，不要重新生图。", { cause }), { code: "IMAGE_RESULT_QUERY_FAILED" });
    }
    if (result.id !== task.id) throw new Error("图像服务返回的任务编号不匹配，已暂停查询。");
    if (result.status === "failed") {
      await input.onUpstreamTask?.({ ...task, status: "failed" });
      throw new Error("上游图片任务已失败，已保留任务编号。请查看服务端失败原因，明确重试后才会重新生图。");
    }
    if (result.status === "completed") {
      const url = publicUrl(result.results?.[0] ?? result.result_data?.[0]?.url);
      await input.onUpstreamTask?.({ ...task, status: "completed" });
      return { url };
    }
    if (!["pending", "processing"].includes(result.status)) throw new Error("图像服务返回未知任务状态，已暂停；继续时只查询原任务。");
    await delay(Math.min(2000, remaining()), undefined, { signal: input.signal });
  }
}
