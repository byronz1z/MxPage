// Prepare and collect via the real app API; start paid calls in the configured browser.
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
const base = "http://127.0.0.1:3000";
const configIndex = process.argv.indexOf("--config");
const config = configIndex >= 0 ? JSON.parse(await fs.readFile(process.argv[configIndex + 1], "utf8")) : null;
const baselineProjectId = config?.baselineProjectId || process.env.MXPAGE_BASELINE_PROJECT;
const completeRetest = process.argv.includes("--complete");
const root = path.resolve(config?.outputRoot || (completeRetest ? "test-output/mug-complete-retest" : "test-output/mug-five-rounds"));
const detailCount = config?.detailCount || (completeRetest ? 8 : 4);
await fs.mkdir(root, { recursive: true });
const manifestPath = path.join(root, "results.json");
let manifest = await fs.readFile(manifestPath, "utf8").then(JSON.parse).catch(() => ({ rounds: [] }));
const [command, roundArg, promptPath] = process.argv.slice(2);
const round = Number(roundArg);
if (!Number.isInteger(round) || (config ? round !== 1 : completeRetest ? round !== 6 : round < 1 || round > 5)) throw new Error("Use rounds 1–5, round 6 with --complete, or round 1 with --config");
const projectName = config?.name || (completeRetest ? "浅棕马克杯 · 完整内容重测" : `马克杯五轮测试 · R${round}`);
const projectDescription = config?.description || "浅棕色马克杯，浅色杯口与底部，弧形侧把手；参考图中杯内有饮品与蒸汽。只销售杯子，道具不属于商品。不知道材质、容量、尺寸、耐热性能、品牌、认证或售后。可以基于外观进行桌面搭配、早餐、阅读和休息场景设计；未知参数留在后台，不成为广告卖点或画面文案。";
const dir = path.join(root, `round-${round}`);
await fs.mkdir(dir, { recursive: true });
const api = async (route, body, method = "POST") => {
  const response = await fetch(base + route, body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok || !value.success) throw new Error(value.error?.message || `HTTP ${response.status}`);
  return value.data;
};
const save = () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
const download = async (url, file) => {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
};
let item = manifest.rounds.find(r => r.round === round);
if (command === "prepare") {
  const instruction = await fs.readFile(promptPath, "utf8");
  if (!item) {
    if (!config && !baselineProjectId) throw new Error("Set MXPAGE_BASELINE_PROJECT or provide --config before preparing a test.");
    const project = round === 1 && !config ? await api(`/api/projects/${baselineProjectId}`) : await api("/api/projects", { name: projectName, platform: "taobao_tmall", style: "generic_clean", description: projectDescription });
    item = { round, projectId: project.id };
    manifest.rounds.push(item);
    await save();
  }
  let project = await api(`/api/projects/${item.projectId}`);
  const run = await api(`/api/projects/${item.projectId}/detail-runs`);
  if (run) throw new Error("This round already has a run. Use status/collect; never repeat a paid request.");
  if (!project.assets.length) {
    const sourceImage = config?.sourceImage || process.env.MXPAGE_TEST_SOURCE;
    if (!sourceImage) throw new Error("Provide sourceImage in --config or set MXPAGE_TEST_SOURCE.");
    const bytes = await fs.readFile(sourceImage);
    await api(`/api/projects/${item.projectId}/assets/upload`, { type: "MAIN", fileName: path.basename(sourceImage), mimeType: config?.mimeType || "image/jpeg", base64Data: bytes.toString("base64") });
  }
  if (completeRetest) {
    project = await api(`/api/projects/${item.projectId}`);
    for (const [fileName, source] of [["round1-layout-reference.png", "round-1/hero-1.png"], ["round2-palette-reference.png", "round-2/detail-3.png"]]) {
      if (project.assets.some(asset => asset.fileName === fileName)) continue;
      const bytes = await fs.readFile(path.resolve("test-output/mug-five-rounds", source));
      await api(`/api/projects/${item.projectId}/assets/upload`, { type: "REFERENCE", purpose: "style_reference", fileName, mimeType: "image/png", base64Data: bytes.toString("base64") });
    }
  }
  const first = config ? project : await api(`/api/projects/${baselineProjectId}`);
  const brief = first.modelSnapshot?.creationBrief;
  if (!config && !brief?.recognition) throw new Error("Await original image recognition in browser before preparing.");
  await api(`/api/projects/${item.projectId}`, {
    name: projectName, platform: "taobao_tmall",
    description: projectDescription,
    modelSnapshot: { creationBrief: brief, creationConfigured: true, commerceCategory: "home", creativePreferences: { version: 2, userDirection: instruction }, previewConfig: { heroImageCount: 3, detailSectionCount: detailCount, contentLanguage: "zh-CN", imageAspectRatio: "3:4", quality: "low", imageSettings: { size: "auto", background: "opaque", outputFormat: "png", outputCompression: 100, moderation: "auto" } } }
  }, "PATCH");
  item.instruction = instruction;
  await fs.writeFile(path.join(dir, "prompt.txt"), instruction, "utf8");
  await save();
  console.log(JSON.stringify({ prepared: round, url: `${base}/projects/${item.projectId}/configure` }));
} else {
  if (!item) throw new Error("Round not prepared");
  const run = await api(`/api/projects/${item.projectId}/detail-runs`);
  const project = await api(`/api/projects/${item.projectId}`);
  const cp = run?.checkpoint;
  console.log(JSON.stringify({ round, projectId: item.projectId, runId: run?.id, status: run?.status, stage: run?.stage, images: cp?.images?.map(i => ({ title: i.title, state: i.state, assetId: i.assetId, issues: i.check?.issues })), error: run?.error || cp?.lastError, questions: cp?.questions, models: run?.input && { planning: run.input.planningModelId, image: run.input.imageModelId, quality: run.input.quality } }, null, 2));
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({ project, run }, null, 2));
  if (command === "preview") {
    const tiles = [];
    for (const [i, section] of project.sections.entries()) {
      if (!section.imageUrl) continue;
      const file = path.join(dir, `preview-${i + 1}.png`);
      await download(section.imageUrl, file);
      const input = await sharp(file).resize(300, 400, { fit: "contain", background: "#eee9e2" }).png().toBuffer();
      tiles.push({ input, top: 30 + Math.floor(i / 4) * 410, left: (i % 4) * 310 });
    }
    if (tiles.length) await sharp({ create: { width: 1240, height: 40 + Math.ceil(project.sections.length / 4) * 410, channels: 3, background: "#eee9e2" } }).composite(tiles).png().toFile(path.join(dir, "contact.png"));
  }
  if (command === "collect" || command === "export") {
    if (!run || (command === "collect" && ["PENDING", "RUNNING", "WAITING_INPUT"].includes(run.status))) throw new Error("Round is still running");
    const sections = project.sections;
    if (sections.length !== 3 + detailCount || sections.some(s => !s.imageUrl)) throw new Error("Incomplete output; preserve state and investigate");
    for (const [i, hero] of sections.filter(s => s.type === "HERO").entries()) await download(hero.imageUrl, path.join(dir, `hero-${i + 1}.png`));
    for (const [i, detail] of sections.filter(s => s.type !== "HERO").entries()) await download(detail.imageUrl, path.join(dir, `detail-${i + 1}.png`));
    await download(`/api/projects/${item.projectId}/export/long-image`, path.join(dir, "detail-long.png"));
    await fs.copyFile(path.join(dir, "hero-1.png"), path.join(dir, "hero.png"));
    await sharp(path.join(dir, "detail-long.png")).resize({ width: 480 }).png().toFile(path.join(dir, "detail-preview.png"));
    item.status = run.status; item.runId = run.id; item.models = run.input; item.setReview = cp.setReview;
    item.hero = `round-${round}/hero.png`; item.detailLong = `round-${round}/detail-long.png`;
    await save();
    console.log(`Collected round ${round}: ${dir}`);
  }
}
