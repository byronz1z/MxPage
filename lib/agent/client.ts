export async function agentFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  try {
    const credentials = JSON.parse(localStorage.getItem("mxpage:agent-credentials:v1") || "{}");
    if (credentials.tavilyKey) headers.set("x-mxpage-tavily-key", credentials.tavilyKey);
    if (credentials.mcpTokens) headers.set("x-mxpage-mcp-tokens", JSON.stringify(credentials.mcpTokens));
  } catch { /* Optional local credentials. */ }
  const response = await fetch(url, { ...init, headers });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error?.message || "请求未完成，请重试。");
  return body.data as T;
}
export const agentStatus: Record<string, string> = { PENDING: "准备中", RUNNING: "执行中", WAITING_APPROVAL: "等待确认方案", WAITING_INPUT: "等待补充信息", PAUSED: "已暂停", INTERRUPTED: "连接已中断", UNCERTAIN: "结果待确认", FAILED: "执行失败", STOPPED: "已停止", COMPLETED: "已完成" };
const internalLabels = { propose_plan: "提交方案", ask_user: "等待补充", task: "执行子任务", model_aux: "整理上下文", write_todos: "更新计划", browser: "操作独立浏览器", ls: "查看草稿目录", read_file: "读取草稿", write_file: "保存草稿", edit_file: "修改草稿", glob: "查找草稿", grep: "搜索草稿" };
export const toolLabels: Record<string, string> = { ...internalLabels, model: "模型回复", search_web: "联网搜索", read_webpage: "读取网页", read_uploaded_file: "分析文件", export_document: "导出文档", create_product: "创建商品作品", recognize_product: "识别商品", create_detail_page: "生成详情页 / 小红书", render_image: "图像生成与编辑", translate_images: "图片翻译", export_project: "导出作品", execute_code: "运行沙箱代码", computer: "操作电脑", desktop_tools: "查看桌面工具", answer_creation_questions: "补充商品信息" };
declare global {
  interface Window {
    mxPageDesktop?: { runtime: string; agent?: { grant: (runId: string, planHash: string) => Promise<void>; stop: () => Promise<void>; status: () => Promise<any>; configureMcp: (servers: unknown[]) => Promise<void> } };
  }
}
