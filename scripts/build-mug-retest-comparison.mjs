import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import archiver from "archiver";

const root = path.resolve("test-output/mug-complete-retest");
const oldRoot = path.resolve("test-output/mug-five-rounds/round-2");
const newRoot = path.join(root, "round-6");
const notes = JSON.parse(await fs.readFile(path.join(root, "review-notes.json"), "utf8"));
const records = [];
for (const [name, source, folder, detailCount] of [["Round 2", oldRoot, "round-2", 4], ["完整内容重测", newRoot, "round-6", 8]]) {
  const { project, run } = JSON.parse(await fs.readFile(path.join(source, "project.json"), "utf8"));
  if (run.input.planningModelId !== "gpt-6-luna" || run.input.imageModelId !== "gpt-image-2.5-flare" || run.input.quality !== "low") throw new Error("Unexpected model or quality");
  if (Object.values(run.checkpoint.attempts).reduce((n, count) => n + count, 0) !== 3 + detailCount || project.sections.some(section => !section.imageUrl)) throw new Error("Incomplete or repeated paid generation");
  if (folder === "round-6" && project.sections.some(section => section.visualPrompt !== section.currentImageAsset?.metadata?.prompt)) {
    // The serializer may expose the prompt on the asset itself; validate against
    // the actual stored generation prompt rather than a generated report label.
    const prompts = project.sections.map(section => ({ stored: section.visualPrompt, actual: section.currentImageAsset?.prompt || section.currentImageAsset?.metadata?.prompt }));
    if (prompts.some(item => item.stored !== item.actual)) throw new Error("Actual image input did not match storyboard");
  }
  const dest = path.join(root, folder);
  await fs.mkdir(dest, { recursive: true });
  const files = ["hero.png", "hero-1.png", "hero-2.png", "hero-3.png", "detail-long.png", "prompt.txt", ...Array.from({ length: detailCount }, (_, i) => `detail-${i + 1}.png`)];
  if (source !== dest) for (const file of files) await fs.copyFile(path.join(source, file), path.join(dest, file));
  const long = await sharp(path.join(dest, "detail-long.png")).metadata();
  const sections = project.sections.map(section => ({ title: section.title, type: section.type, copy: section.copy, prompt: section.visualPrompt }));
  await fs.writeFile(path.join(dest, "generation-prompts.json"), JSON.stringify(sections, null, 2));
  records.push({ name, folder, projectId: project.id, runId: run.id, status: run.status, detailCount, imageCount: 3 + detailCount, quality: run.input.quality, models: { planning: run.input.planningModelId, image: run.input.imageModelId }, longSize: `${long.width} × ${long.height}`, detailCopyCharacters: sections.filter(section => section.type !== "HERO").reduce((sum, section) => sum + section.copy.replace(/\s/g, "").length, 0), coverage: run.checkpoint.plan?.contentCoverage || [], missingFields: run.checkpoint.plan?.missingFields || [], completedReviews: Object.keys(run.checkpoint.imageReviews).length, setReview: run.checkpoint.setReview, lastError: run.checkpoint.lastError, sections, files: [...files, "generation-prompts.json"] });
}
const esc = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const label = (title, subtitle, width) => Buffer.from(`<svg width="${width}" height="100"><rect width="100%" height="100%" fill="#eee5da"/><text x="24" y="42" font-family="Microsoft YaHei, sans-serif" font-size="28" fill="#442c20">${esc(title)}</text><text x="24" y="77" font-family="Microsoft YaHei, sans-serif" font-size="18" fill="#705c4c">${esc(subtitle)}</text></svg>`);
for (const [kind, filename, width] of [["hero", "hero.png", 720], ["detail", "detail-long.png", 540]]) {
  const buffers = await Promise.all(records.map(async record => sharp(path.join(root, record.folder, filename)).resize({ width }).png().toBuffer()));
  const sizes = await Promise.all(buffers.map(buffer => sharp(buffer).metadata()));
  const composites = records.flatMap((record, index) => [{ input: label(record.name, kind === "hero" ? "首张头图 · 原始输出" : `${record.detailCount}屏详情 · 等宽展示`, width), top: 0, left: index * (width + 24) }, { input: buffers[index], top: 100, left: index * (width + 24) }]);
  await sharp({ create: { width: width * 2 + 24, height: Math.max(...sizes.map(size => size.height)) + 100, channels: 3, background: "#eee5da" } }).composite(composites).png().toFile(path.join(root, `${kind}-comparison.png`));
}
if (process.env.MXPAGE_TEST_SOURCE) await fs.copyFile(process.env.MXPAGE_TEST_SOURCE, path.join(root, "source.jpg"));
await fs.access(path.join(root, "source.jpg"));
await fs.writeFile(path.join(root, "comparison-data.json"), JSON.stringify({ records: records.map(({ files, ...record }) => record), notes }, null, 2));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>马克杯完整重测 · 与 Round 2 对比</title>
<style>*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f5f0e9;color:#34291f;font:16px/1.65 system-ui,"Microsoft YaHei",sans-serif}header,main{max-width:1420px;margin:auto;padding:32px}header{display:flex;gap:28px;align-items:center}header img{width:132px;height:132px;object-fit:cover;border-radius:20px}h1{font:500 40px/1.25 Georgia,"Songti SC",serif;margin:8px 0 14px}h2{font-size:23px}p{margin:9px 0}.eyebrow{font-size:12px;letter-spacing:.15em;color:#896344}.muted{color:#7d6d60;font-size:14px}nav{position:sticky;top:0;z-index:2;background:#f5f0e9f5;border-block:1px solid #ded1c1;padding:14px 32px;display:flex;flex-wrap:wrap;gap:10px;justify-content:center}button,.button{font:inherit;padding:10px 18px;border:1px solid #cbb69f;border-radius:999px;background:white;color:#513923;cursor:pointer;text-decoration:none}button.active,.primary{background:#644329;color:white}.intro,.sheet{background:#fffaf4;border:1px solid #e0d3c3;border-radius:18px;padding:24px;margin-bottom:24px}.compare{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}.card{border:1px solid #d9c9b6;background:white;border-radius:18px;overflow:hidden}.card h2{padding:20px 24px;margin:0}.card h2 small{font:12px system-ui;display:block;letter-spacing:.12em;color:#98775c}.card img{display:block;width:100%;height:auto}.detail-image{display:none}body.details .detail-image{display:block}body.details .hero-image{display:none}.links,.card-note{padding:16px 24px}.card-note{background:#fcf8f2;border-bottom:1px solid #e9dfd1;font-size:14px}.links a,a{color:#875022}table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:13px;border-bottom:1px solid #e8ddd0;text-align:left;vertical-align:top}.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.gallery img{width:100%;display:block;border-radius:10px}.gallery a{text-decoration:none}.chapters{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.chapters img{width:100%;display:block}details{padding:14px 0;border-bottom:1px solid #e0d3c3}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;font:14px/1.7 system-ui;overflow-wrap:anywhere}footer{padding:32px;text-align:center;color:#8b7a6b}.pill{font-size:12px;border:1px solid #d9c6ae;padding:3px 9px;border-radius:99px;margin-left:8px}@media(max-width:760px){header,main{padding:18px}header img{width:80px;height:80px}h1{font-size:27px}.compare{gap:10px}.card h2,.card-note,.links{padding:12px;font-size:13px}.chapters{grid-template-columns:repeat(2,1fr)}.sheet{overflow:auto}.gallery{gap:8px}nav{padding:10px}}</style>
<header><img src="source.jpg" alt="本轮使用的原始马克杯照片"><div><div class="eyebrow">MXPAGE / COMPLETE CONTENT RETEST</div><h1>保留暖意，把内容展开</h1><p>延续 Round 1、2 的场景、细节与信息编排。新增 3 张头图 + 8 屏详情。</p><p class="muted">实测模型：gpt-6-luna ＋ gpt-image-2.5-flare　｜　质量 low　｜　2026-10-16</p></div></header>
<nav><button class="active" id="hero">头图并排</button><button id="detail">完整长图并排</button><a class="button primary" href="round-6/detail-long.png" download>下载新详情长图</a><a class="button" href="mug-retest-vs-round2.zip" download>下载原图对比包</a><a class="button" href="#gallery">查看完整套图</a></nav>
<main><section class="intro"><strong>本轮验收：内容完整度、风格延续与事实准确性一起看</strong><p>${esc(notes.summary)}</p><p class="muted">两侧按相同宽度展示，新长图长度是 Round 2 的两倍；没有压扁图片来凑齐高度。图片来自应用实际输出，只做导出拼接与等比缩放，没有后期补字或替换模型。此对比包含提示词、分镜传递修复、风格参考与页数变化，不是单变量实验。</p></section>
<div class="compare">${records.map((record, i) => `<article class="card"><h2><small>${i ? "NEW / COMPLETE RETEST" : "REFERENCE / ROUND 02"}</small>${esc(record.name)}<span class="pill">3头图 + ${record.detailCount}屏详情</span></h2><div class="card-note">${esc(i ? notes.newObservation : notes.oldObservation)}</div><a class="hero-image" href="${record.folder}/hero.png" target="_blank"><img src="${record.folder}/hero.png" alt="${esc(record.name)}首张头图"></a><a class="detail-image" href="${record.folder}/detail-long.png" target="_blank"><img src="${record.folder}/detail-long.png" alt="${esc(record.name)}完整详情长图"></a><div class="links"><a href="${record.folder}/hero.png" download>头图原图</a> · <a href="${record.folder}/detail-long.png" download>详情长图 ${record.longSize}</a> · <a href="/projects/${record.projectId}/editor">应用项目</a></div></article>`).join("")}</div>
<section class="sheet" style="margin-top:24px"><h2>与 Round 2 的具体比较</h2><table><thead><tr><th>维度</th><th>Round 2</th><th>本轮重测</th></tr></thead><tbody>${notes.comparisons.map(row => `<tr><th>${esc(row.dimension)}</th><td>${esc(row.old)}</td><td>${esc(row.new)}</td></tr>`).join("")}<tr><th>规划详情文案字符数</th><td>${records[0].detailCopyCharacters}</td><td>${records[1].detailCopyCharacters}（不等于实际图中文字已逐字验收）</td></tr></tbody></table><p>${esc(notes.limitations)}</p></section>
<section class="sheet" id="gallery"><h2>新一轮 · 3 张头图</h2><div class="gallery">${[1, 2, 3].map(n => `<a href="round-6/hero-${n}.png" target="_blank"><img src="round-6/hero-${n}.png" alt="新头图${n}"><p>头图 ${n} · 点击原图</p></a>`).join("")}</div><h2>8 屏完整详情</h2><div class="chapters">${records[1].sections.filter(section => section.type !== "HERO").map((section, i) => `<a href="round-6/detail-${i + 1}.png" target="_blank"><img loading="lazy" src="round-6/detail-${i + 1}.png" alt="${esc(section.title)}"><p>${i + 1}. ${esc(section.title)}</p></a>`).join("")}</div></section>
<section class="sheet"><h2>内容清单与资料缺口</h2><p>规划已覆盖需求、外观卖点、场景、局部细节、已知商品信息和收口。真实保障与使用说明仍缺资料；“完整”指现有证据范围内的内容展开，不代表已具备所有商家上架资料。</p><table><tbody>${records[1].coverage.map(item => `<tr><th>${esc(item.module)}</th><td>${item.status === "covered" ? "已安排" : "缺少资料"}</td><td>${esc(item.reason)}</td></tr>`).join("")}</tbody></table><details><summary>查看完整规划文案与后台缺失项</summary>${records[1].sections.map((section, i) => `<h3>${i + 1}. ${esc(section.title)}</h3><pre>${esc(section.copy)}</pre>`).join("")}<pre>${esc(records[1].missingFields.map(field => field.question).join("\n"))}</pre></details></section>
<section class="sheet"><h2>真实执行记录</h2><p>${esc(notes.execution)}</p><table><thead><tr><th>版本</th><th>原始图片</th><th>单图质检有返回</th><th>工作流状态</th></tr></thead><tbody>${records.map(record => `<tr><th>${record.name}</th><td>${record.imageCount}/${record.imageCount}</td><td>${record.completedReviews}/${record.imageCount}</td><td>${record.status}</td></tr>`).join("")}</tbody></table><details><summary>逐图实看记录</summary>${notes.pageReviews.map(item => `<p><strong>${esc(item.page)}：</strong>${esc(item.observation)}</p>`).join("")}</details><details><summary>查看本轮实际创作指令</summary><pre>${esc(await fs.readFile(path.join(newRoot, "prompt.txt"), "utf8"))}</pre></details><p><a href="comparison-data.json" download>下载对比记录</a> · <a href="round-6/generation-prompts.json" download>下载实际分镜提示词</a> · <a href="hero-comparison.png" download>头图并排 PNG</a> · <a href="detail-comparison.png" download>长图并排 PNG</a></p></section></main><footer>原始商品图：用户提供的 images.jpg。没有用虚构参数、优惠或服务承诺补齐内容。</footer><script>const hero=document.querySelector('#hero'),detail=document.querySelector('#detail');hero.onclick=()=>{document.body.classList.remove('details');hero.classList.add('active');detail.classList.remove('active')};detail.onclick=()=>{document.body.classList.add('details');detail.classList.add('active');hero.classList.remove('active')};</script></html>`;
await fs.writeFile(path.join(root, "index.html"), html, "utf8");
const sharedFiles = ["index.html", "source.jpg", "hero-comparison.png", "detail-comparison.png", "comparison-data.json", "review-notes.json"];
await new Promise((resolve, reject) => {
  const output = createWriteStream(path.join(root, "mug-retest-vs-round2.zip"));
  const zip = archiver("zip", { zlib: { level: 5 } });
  output.on("close", resolve); output.on("error", reject); zip.on("error", reject); zip.pipe(output);
  for (const file of sharedFiles) zip.file(path.join(root, file), { name: file });
  for (const record of records) for (const file of record.files) zip.file(path.join(root, record.folder, file), { name: `${record.folder}/${file}` });
  zip.finalize();
});
const publicRoot = path.resolve("public/test-reports/mug-complete-retest");
await fs.mkdir(publicRoot, { recursive: true });
for (const file of [...sharedFiles, "mug-retest-vs-round2.zip"]) await fs.copyFile(path.join(root, file), path.join(publicRoot, file));
for (const record of records) {
  await fs.mkdir(path.join(publicRoot, record.folder), { recursive: true });
  for (const file of record.files) await fs.copyFile(path.join(root, record.folder, file), path.join(publicRoot, record.folder, file));
}
console.log(JSON.stringify({ root, publicRoot, records: records.map(({ name, imageCount, longSize }) => ({ name, imageCount, longSize })) }));
