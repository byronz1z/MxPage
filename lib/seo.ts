export const productTitle = "MxPage · AI 电商详情页与商品图工作台";
export const productDescription = "开源 AI 电商详情页生成工具，支持商品主图、完整详情长图、批量图片翻译、小红书图文、断点恢复与费用监控，可本地部署或使用 Windows / macOS 桌面版。";

export function publicSiteUrl() {
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
    return new URL(url.origin);
  } catch { return undefined; }
}
