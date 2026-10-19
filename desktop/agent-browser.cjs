const path = require("node:path");
const fs = require("node:fs/promises");
const dns = require("node:dns/promises");
const { app } = require("electron");
const contexts = new Map();
async function assertPublic(address) {
  const url = new URL(address);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("浏览器只支持公开 HTTP(S) 地址。");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.some(({ address: a }) => /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::|f[cd]|fe[89ab])/i.test(a))) throw new Error("浏览器不允许访问本机或私有网络。");
}
async function contextFor(runId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("任务标识无效。");
  if (contexts.has(runId)) return contexts.get(runId);
  const { chromium } = await import("playwright-core");
  const candidates = process.platform === "win32" ? [path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"), path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe")] : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  let executablePath;
  for (const file of candidates) if (await fs.stat(file).then(s => s.isFile()).catch(() => false)) { executablePath = file; break; }
  if (!executablePath) throw new Error("未找到 Chrome 或 Edge，请安装后再使用浏览器操作。");
  const context = await chromium.launchPersistentContext(path.join(app.getPath("userData"), "agent-browser", runId), { executablePath, headless: false, acceptDownloads: true });
  await context.route("**/*", async route => { try { await assertPublic(route.request().url()); await route.continue(); } catch { await route.abort(); } });
  const cdp = await context.browser().newBrowserCDPSession();
  const processes = await cdp.send("SystemInfo.getProcessInfo"); await cdp.detach();
  const value = { context, page: context.pages()[0] || await context.newPage(), download: null, pid: processes.processInfo.find(p => p.type === "browser")?.id, observedUrl: null };
  value.page.on("download", download => { value.download = download; });
  contexts.set(runId, value); return value;
}
async function browserCall(runId, grant, input, beforeMutate) {
  if (!grant.plan.tools.includes("browser")) throw new Error("浏览器工具未批准。");
  const state = await contextFor(runId), page = state.page;
  if (grant.stopped) { await closeBrowsers(runId); throw new Error("浏览器控制已停止。"); }
  if (["click", "fill", "key"].includes(input.action)) {
    if (grant.observe || state.observedUrl !== page.url()) throw new Error("页面已改变或尚未观察，请先观察当前页面。");
    await beforeMutate(state);
    if (grant.stopped) throw new Error("浏览器控制已停止。");
  }
  if (input.action === "navigate") { await assertPublic(input.url); await page.goto(input.url, { timeout: 20000, waitUntil: "domcontentloaded" }); }
  else if (input.action === "click") await page.locator(input.selector).first().click({ timeout: 10000 });
  else if (input.action === "fill") await page.locator(input.selector).first().fill(input.text || "", { timeout: 10000 });
  else if (input.action === "key") await page.locator(input.selector || "body").press(input.text, { timeout: 10000 });
  else if (input.action === "download") {
    if (!state.download) throw new Error("当前没有可下载的成果。");
    const filename = await state.download.path(); const stat = await fs.stat(filename);
    if (stat.size > 25 * 1024 * 1024) throw new Error("下载超过 25MB。");
    const bytes = await fs.readFile(filename); state.download = null;
    return { download: { name: input.name || "download.txt", data: bytes.toString("base64") } };
  } else if (!["observe", "screenshot"].includes(input.action)) throw new Error("不支持的浏览器操作。");
  const screenshot = await page.screenshot({ type: "png" });
  state.observedUrl = page.url(); grant.observe = false;
  return { content: [{ type: "text", text: JSON.stringify({ url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 20000), controls: await page.locator("input,textarea,button,a,select").evaluateAll(elements => elements.slice(0, 80).map(element => ({ tag: element.tagName, id: element.id, name: element.getAttribute("name"), role: element.getAttribute("role"), label: element.getAttribute("aria-label") || element.textContent?.slice(0, 80) }))) }) }, { type: "image", mimeType: "image/png", data: screenshot.toString("base64") }] };
}
async function closeBrowsers(runId) { for (const [id, value] of contexts) if (!runId || runId === id) { await value.context.close(); contexts.delete(id); } }
module.exports = { browserCall, closeBrowsers };
