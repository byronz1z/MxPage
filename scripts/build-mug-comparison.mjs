import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import archiver from "archiver";

const root = path.resolve("test-output/mug-five-rounds");
const manifest = JSON.parse(await fs.readFile(path.join(root, "results.json"), "utf8"));
const notes = JSON.parse(await fs.readFile(path.join(root, "review-notes.json"), "utf8"));
if (manifest.rounds.length !== 5 || manifest.rounds.some(r => !r.hero || !r.detailLong)) throw new Error("Collect all five real rounds first");
const esc = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rounds = [];
for (const round of manifest.rounds) {
  const { project, run } = JSON.parse(await fs.readFile(path.join(root, `round-${round.round}/project.json`), "utf8"));
  if (run.input.planningModelId !== "gpt-6-luna" || run.input.imageModelId !== "gpt-image-2.5-flare" || run.input.quality !== "low") throw new Error("Unexpected model or quality");
  const attempts = Object.values(run.checkpoint.attempts).reduce((a, b) => a + b, 0);
  if (attempts !== 7 || run.checkpoint.images.filter(i => i.assetId).length !== 7) throw new Error("Unexpected generation count");
  const prompts = project.sections.map(section => ({ section: section.order, title: section.title, actualImagePrompt: section.currentImageAsset.metadata.prompt, savedStoryboardPrompt: section.visualPrompt, matchesStoryboard: section.currentImageAsset.metadata.prompt === section.visualPrompt }));
  if (round.round >= 4 && prompts.some(p => !p.matchesStoryboard)) throw new Error("Finalized storyboard was not passed to generation");
  await fs.writeFile(path.join(root, `round-${round.round}/generation-prompts.json`), JSON.stringify(prompts, null, 2), "utf8");
  const timings = Object.fromEntries(Object.entries(run.checkpoint.timings).map(([stage, t]) => [stage, t.finishedAt ? Math.round((Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000) : null]));
  rounds.push({ round: round.round, projectId: round.projectId, runId: run.id, status: run.status, models: { planning: run.input.planningModelId, image: run.input.imageModelId, quality: run.input.quality }, images: 7, attempts, reviewCompleted: Object.keys(run.checkpoint.imageReviews).length, lastError: run.checkpoint.lastError || null, setReview: run.checkpoint.setReview || null, timings, ...notes.find(n => n.round === round.round) });
}
await fs.writeFile(path.join(root, "comparison-data.json"), JSON.stringify(rounds, null, 2), "utf8");
if (process.env.MXPAGE_TEST_SOURCE) await fs.copyFile(process.env.MXPAGE_TEST_SOURCE, path.join(root, "source.jpg"));
await fs.access(path.join(root, "source.jpg"));

for (const [kind, width, height] of [["hero", 600, 600], ["detail", 360, 1920]]) {
  const layers = [];
  for (const [i, r] of rounds.entries()) {
    const imagePath = path.join(root, `round-${r.round}`, kind === "hero" ? "hero.png" : "detail-long.png");
    const tile = await sharp(imagePath).resize(width, height, { fit: "contain", background: "#f4eee5" }).png().toBuffer();
    const label = Buffer.from(`<svg width="${width}" height="64"><rect width="100%" height="100%" fill="#453329"/><text x="24" y="42" fill="#fff" font-family="sans-serif" font-size="28">ROUND ${r.round}</text></svg>`);
    layers.push({ input: label, left: i * (width + 12), top: 0 }, { input: tile, left: i * (width + 12), top: 64 });
  }
  await sharp({ create: { width: 5 * width + 4 * 12, height: height + 64, channels: 3, background: "#fff" } }).composite(layers).png().toFile(path.join(root, `${kind}-comparison.png`));
}

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>马克杯 · 五轮实测对比</title>
<style>:root{color:#36291f;background:#f5f1ea;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:1800px;margin:auto;padding:32px}header{display:flex;gap:32px;align-items:center}header img{width:130px;border-radius:16px}h1{font-size:38px;line-height:1.25;margin:8px 0}h2{font-size:24px;margin:0 0 20px}p{margin:8px 0}.eyebrow{font-size:12px;letter-spacing:3px;color:#836954}a{color:#765239}nav{position:sticky;top:0;z-index:4;background:#f5f1eaf5;padding:14px 32px;border-bottom:1px solid #ded4c7;display:flex;gap:12px;align-items:center;flex-wrap:wrap}button,.button{border:1px solid #c7b9a6;border-radius:30px;padding:10px 18px;background:white;color:#453329;text-decoration:none;cursor:pointer;font:inherit}button.active{background:#453329;color:white}main{padding-top:20px}.notice{padding:20px 24px;border:1px solid #d8c9b4;border-radius:16px;background:#fffaf2;margin-bottom:26px}.compare{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:16px;overflow:auto;padding-bottom:20px}.card{background:white;border:1px solid #e6ddd1;border-radius:16px;overflow:hidden}.card h3,.card .note,.card .links{padding:0 16px}.card h3{font-size:19px;line-height:1.4;min-height:54px}.card h3 small{display:block;color:#947860;font-size:12px;letter-spacing:2px}.card .note{font-size:13px;min-height:160px;color:#655446}.card img{display:block;width:100%;height:auto}.card .links{font-size:12px;padding-top:12px;padding-bottom:12px}.detail-image{display:none}body.details .hero-image{display:none}body.details .detail-image{display:block}.sheet{margin:32px 0;background:white;padding:24px;border-radius:16px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:12px;border-bottom:1px solid #e9e1d7}details{margin:16px 0}pre{white-space:pre-wrap;font:13px/1.8 system-ui;background:#f5f1ea;padding:20px;border-radius:10px}.muted{color:#806f5e;font-size:13px}footer{font-size:13px;color:#806f5e}@media(max-width:700px){header,main,footer{padding:20px}h1{font-size:28px}header img{width:90px}header{gap:16px}.compare{grid-template-columns:repeat(5,260px)}nav{padding:10px 20px}.sheet{overflow:auto}}</style>
<header><img src="source.jpg" alt="用户提供的原始马克杯照片"><div><div class="eyebrow">MXPAGE / REAL WORKFLOW TEST</div><h1>同一只杯子，五轮真实迭代</h1><p>每轮 3 张头图 + 4 屏详情。共 35 张原始输出，5 张详情长图。</p><p class="muted">规划与质检：gpt-6-luna　｜　出图：gpt-image-2.5-flare　｜　质量：low</p></div></header>
<nav><button class="active" id="hero">头图并排</button><button id="detail">详情长图并排</button><a class="button" href="mug-five-rounds.zip" download>下载完整对比包</a><a href="#records">查看测试记录与提示词</a></nav>
<main><div class="notice"><strong>实测说明</strong><p>对比展示应用直接导出的图片，只做等比例缩放和拼接，没有另换模型或后期补字。前 3 轮暴露了出图使用旧规划文案的问题，第 4 轮起实际使用完整分镜；因此这里包含程序修复的影响，不是纯提示词 A/B 实验。每轮改进有实际结果支撑，但不宣称质量严格逐轮提高，也不代表实际转化率测试。</p><p>自动质检中存在超时，PARTIAL 不代表图片缺失。具体问题以各轮备注为准；原始结果全部保留。</p></div>
<div class="compare">${rounds.map(r => `<article class="card"><h3><small>ROUND 0${r.round}</small>${esc(r.title)}</h3><div class="note"><p><strong>本轮调整：</strong>${esc(r.change)}</p><p><strong>实图观察：</strong>${esc(r.observation)}</p></div><a class="hero-image" href="round-${r.round}/hero.png" target="_blank"><img src="round-${r.round}/hero.png" alt="第${r.round}轮原始首张头图"></a><a class="detail-image" href="round-${r.round}/detail-long.png" target="_blank"><img src="round-${r.round}/detail-long.png" alt="第${r.round}轮完整详情长图"></a><div class="links"><a href="round-${r.round}/hero.png" download>头图 PNG</a> · <a href="round-${r.round}/detail-long.png" download>长图 PNG</a> · <a href="http://127.0.0.1:3000/projects/${r.projectId}" target="_blank">应用项目</a></div></article>`).join("")}</div>
<section class="sheet" id="records"><h2>执行记录</h2><table><thead><tr><th>轮次</th><th>图片</th><th>规划 / 分镜 / 出图耗时</th><th>返回单图质检</th><th>工作流状态</th></tr></thead><tbody>${rounds.map(r => `<tr><td>R${r.round}</td><td>7 / 7</td><td>${r.timings.PLAN ?? "—"}s / ${r.timings.ART_DIRECTION ?? "—"}s / ${r.timings.GENERATE ?? "—"}s</td><td>${r.reviewCompleted} / 7</td><td>${esc(r.status)}</td></tr>`).join("")}</tbody></table><p class="muted">出图耗时包含并发等待；不含随后进行的单图及整套质检。每轮每张只请求一次出图，没有为改善评分自动重新付费生成。</p></section>
<section class="sheet"><h2>逐轮提示词与完整头图组</h2>${await Promise.all(rounds.map(async r => `<details><summary>R${r.round} · ${esc(r.title)}</summary><p>${[1, 2, 3].map(n => `<a href="round-${r.round}/hero-${n}.png" target="_blank">头图 ${n}</a>`).join(" · ")} · <a href="round-${r.round}/prompt.txt" download>下载提示词</a></p><pre>${esc(await fs.readFile(path.join(root, `round-${r.round}/prompt.txt`), "utf8"))}</pre></details>`)).then(a => a.join(""))}</section>
</main><footer>原始素材仅能确认外观；没有提供的容量、尺寸、材质与服务承诺不应成为商品卖点。测试日期：2026-10-16。</footer>
<script>const hero=document.querySelector('#hero'),detail=document.querySelector('#detail');hero.onclick=()=>{document.body.classList.remove('details');hero.classList.add('active');detail.classList.remove('active')};detail.onclick=()=>{document.body.classList.add('details');detail.classList.add('active');hero.classList.remove('active')};</script></html>`;
await fs.writeFile(path.join(root, "index.html"), html
  .replace("每轮改进有实际结果支撑", "每轮均根据上一轮的实际结果调整")
  .replace(/http:\/\/127\.0\.0\.1:3000\/projects\/(cm[a-z0-9]+)"/g, 'http://127.0.0.1:3000/projects/$1/editor"')
  .replace("具体问题以各轮备注为准；原始结果全部保留。", "具体问题以各轮备注为准；原始结果全部保留。文件元数据确认：所有头图 1024×1024、详情单屏 1152×1536、长图 1080×5760。第五轮质检中的 2:3 比例提示属于误报。"), "utf8");
const zipPath = path.join(root, "mug-five-rounds.zip");
await new Promise((resolve, reject) => {
  const out = createWriteStream(zipPath), zip = archiver("zip", { zlib: { level: 5 } });
  out.on("close", resolve); out.on("error", reject); zip.on("error", reject); zip.pipe(out);
  for (const file of ["index.html", "source.jpg", "hero-comparison.png", "detail-comparison.png", "comparison-data.json", "review-notes.json"]) zip.file(path.join(root, file), { name: file });
  for (const r of rounds) for (const file of ["hero.png", "hero-1.png", "hero-2.png", "hero-3.png", "detail-1.png", "detail-2.png", "detail-3.png", "detail-4.png", "detail-long.png", "prompt.txt", "generation-prompts.json"]) zip.file(path.join(root, `round-${r.round}`, file), { name: `round-${r.round}/${file}` });
  zip.finalize();
});
// Publish only the explicit deliverables to the local preview server, not raw
// database snapshots or provider configuration.
const publicRoot = path.resolve("public/test-reports/mug-five-rounds");
await fs.mkdir(publicRoot, { recursive: true });
for (const file of ["index.html", "source.jpg", "hero-comparison.png", "detail-comparison.png", "comparison-data.json", "review-notes.json", "mug-five-rounds.zip"]) await fs.copyFile(path.join(root, file), path.join(publicRoot, file));
for (const r of rounds) {
  await fs.mkdir(path.join(publicRoot, `round-${r.round}`), { recursive: true });
  for (const file of ["hero.png", "hero-1.png", "hero-2.png", "hero-3.png", "detail-1.png", "detail-2.png", "detail-3.png", "detail-4.png", "detail-long.png", "prompt.txt", "generation-prompts.json"]) await fs.copyFile(path.join(root, `round-${r.round}`, file), path.join(publicRoot, `round-${r.round}`, file));
}
console.log(JSON.stringify({ root, rounds: rounds.length, images: rounds.reduce((n, r) => n + r.images, 0), zip: zipPath, zipMB: Math.round((await fs.stat(zipPath)).size / 1024 / 1024) }));
