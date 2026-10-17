import { writeFileSync } from "node:fs";
import { commercePlanSchema, validateCommercePlan } from "../lib/detail-runs/merchandising";
import { currentArtDirectionSchema, validateArtDirection, compileArtPrompt } from "../lib/detail-runs/art-direction";

// Authored example from the actual supplied photograph; no model or paid image calls.
const sourceId = "cmumrwhwd0033jdnkpo40blgv";
const sourcePath = "D:/File/Codex/MxinspireFlowGpt/repo/storage/uploads/cmumrwhor0031jdnknp010zyu/1790692201882-Ls6yp--screenshot-20260530-133852.png";
const evidence = [
  { id: "identity", claim: "用户原图展示吹风机，机身可见 SALONIA 字样；该字样不构成真伪或授权证明。" },
  { id: "appearance", claim: "原图展示黑色与白色外观；不据此推断在售 SKU、套装或发货数量。" },
  { id: "shape", claim: "横向筒状机身、竖直手柄；筒身与手柄连接处的形状和接缝可见。" },
  { id: "cord", claim: "手柄底部连接线缆，连接区域附近可见环形挂环；插头未显示。" },
].map(e => ({ ...e, source: "image" as const, sourceRef: sourceId }));
const palette = ["#222523", "#F2F0E9", "#97A99B", "#C9CFCB"];
const frames = [
  {
    id: "H1", kind: "HERO", title: "黑白有型 · 封面主视觉", role: "positioning", question: "这是什么商品，它的视觉气质如何？",
    task: "以双层空间和黑白对照建立商品辨识度；缩略图先认出吹风机轮廓，再读到主题。", facts: ["identity", "appearance", "shape"],
    composition: "offset_hero", layout: "full_bleed", density: "balanced", scale: "dominant", view: "three_quarter",
    camera: "中长焦近景，镜头向机身可见侧绕转约 30°，高度略低于筒身；呈现真实斜侧深度，保留标识所在面，不正对未知出风口或后网结构。",
    subject: "白色主体在右前方占画面约 60%，黑色主体位于左后方；手柄、筒身比例与原图一致，两台高低错位而非平行贴图。",
    background: "石墨色摄影空间，一块暖白折面台体承托商品，远处窄幅鼠尾草绿反光；不沿用原图灰墙平铺构图。",
    lighting: "左上大柔光塑造圆筒过渡，右后细轮廓光分离黑色边缘，阴影落在真实台面；标签不被高光冲掉。",
    graphic: "标题侧一枚细长鼠尾草绿括线与手柄方向呼应，不加奖章、价格条或卖点贴纸。",
    copy: ["黑白有型\n日常有序", "SALONIA 吹风机"],
    type: "窄体中黑中文作主标题，黑白二字加大，第二行较轻；产品名称用疏朗小号无衬线。",
    textLayout: "主题位于左上约三分之一宽度，两行错位；商品名贴近括线底端，文字不压住机身标识。", accent: "黑白有型四字形成视觉主音，日常有序退为次级，不把两行排成等大方块。", textColor: "#F2F0E9",
  },
  {
    id: "H2", kind: "HERO", title: "梳妆空间 · 场景头图", role: "scenario", question: "它放在日常空间中是什么感觉？",
    task: "用环境比例和陈列关系展示日常氛围，与封面的棚拍近景拉开距离。", facts: ["identity", "shape"],
    composition: "full_scene", layout: "editorial", density: "airy", scale: "environmental", view: "front",
    camera: "平视中远景，镜头面向商品可见标识侧；保留桌面纵深和窗光投影，主体不占满画面。",
    subject: "单台黑色吹风机自然斜放于干燥梳妆台右侧，机身占画面约三分之一；线缆自然延伸出画面，不能画成无线产品。",
    background: "暖白墙面、灰绿镜框局部与哑光台面；只用少量生活道具，不呈现浴缸、水流或随箱赠品陈列。",
    lighting: "左侧窗光在背景形成大面积斜影，商品用柔和补光保留暗部；接触阴影与窗光方向一致。",
    graphic: "用窗影和细短横线承接文案，不额外叠加图标；装饰让位于环境留白。",
    copy: ["梳妆台的一席之地"],
    type: "中等字重的编辑式中文，舒展字距，避免封面式巨大粗黑字。",
    textLayout: "标题在左下空墙区域，拆成两段有呼吸的短行；横线紧贴第一段基线。", accent: "一席之地略加重，其余保持轻盈；不增加第二层口号。", textColor: "#222523",
  },
  {
    id: "H3", kind: "HERO", title: "细节放大 · 结构头图", role: "detail", question: "外形和手柄底部细节能否看清？",
    task: "以真实局部作为视觉证据，补充前两张无法看清的连接处与挂环，不宣称折叠、耐用或收纳性能。", facts: ["shape", "cord"],
    composition: "macro_crop", layout: "macro", density: "informative", scale: "macro", view: "macro",
    camera: "微距镜头对准可见筒身与手柄连接处，另一个小局部呈现原图可见的底部挂环；不生成内部剖面或看不见的开关刻度。",
    subject: "大局部跨越右侧画面边界，小局部位于左下且无外框；产品占比与封面完整机身形成明显变化。",
    background: "暖白纸感摄影场与局部石墨暗面分区；局部照片共享一种光线，不能做成两张模板卡片。",
    lighting: "宽柔光突出表面弧度，浅阴影显露接缝，控制景深让被标注部位清晰。",
    graphic: "两条短引线准确指向连接处和挂环；鼠尾草色小圆点只落在背景侧，不覆盖产品。",
    copy: ["把细节，看得更近", "筒身与手柄", "底部挂环"],
    type: "中黑标题配较细的技术说明字，数字式装饰和英文字母均省略。",
    textLayout: "标题沿左上区域竖向留白分两行；两枚标签分别靠近对应局部，不堆在顶部。", accent: "细节二字以鼠尾草色短底线强调，标签小一档但在手机上仍可读。", textColor: "#222523",
  },
  {
    id: "D1", kind: "DETAIL", title: "吹发日常 · 长页开场", role: "positioning", question: "这套产品展示希望带来怎样的日常感受？",
    task: "把品类用途与黑白造型结合，打开生活方式叙事；用大画面完成定位，而非把功率等未知项写成卖点。", facts: ["identity", "appearance", "shape"],
    composition: "diagonal", layout: "full_bleed", density: "airy", scale: "dominant", view: "side",
    camera: "侧面长焦产品肖像，两台机身以不同高度沿对角线展开；保持筒身、直柄与原图可见接缝，不新增背面图案。",
    subject: "黑色主体在暖白区域，白色主体在石墨区域，主次比例约 2:1；至少一台轮廓完整，线缆以自然弧线延展。",
    background: "上部石墨摄影场过渡到暖白弧形台面，近下缘融入统一暖白；没有作品展示板、多列长图或边框。",
    lighting: "柔和侧光与窄轮廓光使黑白材质都可辨，背景明暗有层次且不过曝。",
    graphic: "一条宽而克制的弧面组织商品与文字，与头图括线属于同一设计语言，不绘制气流性能示意。",
    copy: ["吹发日常\n自有格调", "SALONIA 吹风机", "黑白外观 · 直柄轮廓"],
    type: "与封面同族的中黑字，格调两字留出更宽字距，小号产品名维持规则对齐。",
    textLayout: "大标题在上半部居左，商品跨中下部；说明排在场景留白中，不能当重复页脚。", accent: "格调作为第二行视觉重点，末行小字只补充身份信息。", textColor: "#F2F0E9",
  },
  {
    id: "D2", kind: "DETAIL", title: "立体轮廓与真实细节", role: "evidence", question: "哪些结构细节能支持对外形设计的判断？",
    task: "用一张有深度的斜侧主照片和两个清楚局部，解释轮廓、连接处和线缆关系；不是重复一次全机身配标题。", facts: ["shape", "cord"],
    composition: "editorial_split", layout: "split", density: "informative", scale: "macro", view: "three_quarter",
    camera: "上方主照片从可见侧绕转约 35°并轻微俯视，形成筒身纵深；下方放大原图可见连接处与线缆根部，不展示未知后网和内部机构。",
    subject: "主照片占上部约 55%；下部左右错位的两个局部与短标签构成编辑页，留白和比例不同于 H3 的单个大特写。",
    background: "暖白起始区域向灰绿中段过渡，底部收回暖白；照片分区用色面而非外框。",
    lighting: "左上同向柔光，局部用近距离侧向补光突出立体接缝，不加夸张金属反射。",
    graphic: "短引线与细线分区建立阅读顺序，不画爆炸图、结构透视或技术认证图标。",
    copy: ["线条之外\n细节之内", "筒身连接处", "环形挂环", "底部线缆"],
    type: "中黑标题与细字标签同族，连接处等标签保持轻量，避免写成广告徽章。",
    textLayout: "标题位于主照片左侧留白，标签分别贴近对应局部；两条主标题行长有差异。", accent: "细节用深绿色强化一次，三枚标签不全部加粗或描边。", textColor: "#222523",
  },
  {
    id: "D3", kind: "DETAIL", title: "人与商品 · 日常关系", role: "scenario", question: "在真实生活中，商品和人的关系如何？",
    task: "通过手持动作和干燥梳妆空间建立生活尺度，展示接触与使用情境；不暗示轻量、速干或护发效果。", facts: ["identity", "shape", "cord"],
    composition: "full_scene", layout: "editorial", density: "airy", scale: "environmental", view: "top_down",
    camera: "镜头从上方约 60°俯拍台面与手部，白色吹风机斜穿画面；可见侧标识与手柄关系清楚，不把机身摆回原图的水平姿态。",
    subject: "一只成人手自然握住手柄，产品位于中下部，线缆松弛延伸；只展示手部和干燥台面，不画发丝变化或效果对比。",
    background: "暖白梳妆台面、灰绿布料局部与背景边缘镜框，简洁真实；上下均自然融入暖白衔接色。",
    lighting: "自然窗光，皮肤与机身共享真实色温，手部接触处有柔和阴影，不用磨皮发光质感。",
    graphic: "短标题旁一条随手势方向的弧线，其他装饰省略，用真实摄影完成画面。",
    copy: ["把日常\n放进画面"],
    type: "同族较轻字重，宽松行距，让手势与主体成为重点。",
    textLayout: "标题沿左上留白呈阶梯式排列，不能落在手指、机身或线缆上。", accent: "日常略加重，后半句保留柔和字重，以留白而非更多标语建立层次。", textColor: "#222523",
  },
  {
    id: "D4", kind: "DETAIL", title: "外观对照 · 产品档案收尾", role: "selection", question: "选购前，有哪些外观与结构信息可以确认？",
    task: "以清楚的黑白外观对照与已知产品档案收尾；将未知功率、档位、尺寸、配件和售后整项省略，不留下空表。", facts: ["identity", "appearance", "shape", "cord"],
    composition: "information_grid", layout: "spec_table", density: "informative", scale: "dominant", view: "front",
    camera: "平视可见标识侧，黑色与白色机身分别拍摄成清楚的完整侧面肖像；只做外观对照，不模拟 SKU 选择按钮。",
    subject: "两种外观在上半部按统一高度对齐，下半部为三组已知信息；轮廓和机身标识必须清楚，不能加包装盒或多余附件。",
    background: "连续暖白摄影底，档案区域用极浅灰绿底色和细分隔线，不做整张圆角卡片。",
    lighting: "明亮柔光保持黑白两种表面有层次，落地接触阴影低对比；下方文字区域照明均匀。",
    graphic: "三行档案用细线和字重形成秩序，外观标签只在对应商品下方各出现一次。",
    copy: ["一页看清\n心中有数", "黑色外观", "白色外观", "品类｜吹风机", "形态｜筒状机身 · 直柄", "底部｜连接线缆 · 环形挂环"],
    type: "标题中黑，信息字段中等字重、值为常规字重；避免把所有参数做成同样醒目的大字。",
    textLayout: "标题在上部居左，外观标签在两张肖像下方；档案以三行横向对齐，375px 下字号不小于约 14px。", accent: "一页看清突出，档案字段齐左，主体与三行信息之间保持充足留白。", textColor: "#222523",
  },
] as const;

const plan = commercePlanSchema.parse({
  version: 2, category: "appliances", productName: "SALONIA 吹风机 · 黑白外观展示",
  audience: "希望看清外观设计与生活场景的吹风机选购者", positioning: "以黑白造型与日常梳妆场景建立辨识度，用真实局部和外观档案完成选购信息。",
  facts: evidence.map(e => e.claim), evidence,
  style: "黑白有型：石墨、暖白与鼠尾草绿的家电编辑摄影",
  visualSystem: { palette, typography: "同族窄体中黑标题与常规无衬线说明，主题字有选择地放大；版面按摄影任务变化。", lighting: "自然柔光与轮廓光统一方向，保留黑白机身的立体过渡；场景中接触阴影真实。", composition: "雕塑封面、远景情境、局部摄影、斜侧解释与档案对照交替。", continuity: "四张详情边缘共享暖白 #F2F0E9，深浅变化在屏内完成，无外框和分隔空隙。" },
  sections: frames.map(f => ({ kind: f.kind, title: f.title, role: f.role, buyerQuestion: f.question, objective: f.task, factIds: f.facts, copy: f.copy.join("\n"), prompt: `${f.camera} ${f.background} ${f.lighting}`, layout: f.layout, visualFocus: `${f.subject} ${f.textLayout}`, transition: f.kind === "DETAIL" ? "屏内转换景别与明暗，切口共享暖白 #F2F0E9。" : "独立头图，保持品牌色与字体家族一致。" })),
});
const details = frames.filter(f => f.kind === "DETAIL");
const artDirection = currentArtDirectionSchema.parse({
  version: 2, layoutVersion: 1, viewVersion: 1, recipeId: "monochrome_precision",
  concept: "黑白有型：让家电摄影拥有编辑杂志的空间、字形与生活温度",
  rationale: "借鉴黑白案例的明暗层次和蓝白雕塑案例的曲面受光；转为石墨、暖白、灰绿配色，不复制参考商品、商标或功效。镜头从立体主视觉走向环境、局部、人的关系与清楚档案。",
  palette, headlineStyle: "窄体中黑中文与常规无衬线同族，主题词通过字距、字重和位置区别，不给每屏套固定顶栏。", bodyStyle: "小号常规无衬线，清楚字段和对应关系，按 375px 手机宽度检查行距与可读性。", motif: "括线、宽弧面和短引线沿产品轮廓组织空间，灰绿只作强调，不滥加促销贴纸。", lighting: "主体同向柔光，黑色机身加克制轮廓光；真实接触阴影贯穿全套。",
  detailSeams: details.slice(1).map((f, i) => ({ fromSectionId: details[i].id, toSectionId: f.id, color: "#F2F0E9" })),
  sections: frames.map(f => ({ sectionId: f.id, title: f.title, task: f.task, composition: f.composition, density: f.density, productScale: f.scale, viewpoint: f.view, subjectPlacement: f.subject, camera: f.camera, background: f.background, lighting: f.lighting, graphicDevice: f.graphic, typography: { fontCharacter: f.type, layout: f.textLayout, emphasis: f.accent, decoration: f.graphic }, textBlocks: f.copy.map((text, i) => ({ text, role: i === 0 ? "headline" : i === 1 && f.kind === "HERO" ? "support" : "label", placement: i === 0 ? f.textLayout : "按照版面描述靠近对应产品、局部或信息行，与其他文本保留清楚间距。", size: i === 0 ? "display" : "body", color: i === 0 ? f.textColor : f.id === "H1" || f.id === "D1" ? "#F2F0E9" : "#222523" })), continuity: f.kind === "DETAIL" ? "接缝终端全宽 2% 自然融入暖白 #F2F0E9，文字、产品和硬阴影避开切口，屏内仍保留摄影质感。" : "与全套共享光线、字体家族与色彩，不复制其他头图的构图或机位。" })),
});
const targets = frames.map(f => ({ id: f.id, kind: f.kind, copy: f.copy.join("\n") }));
const issues = [...validateCommercePlan(plan, [sourceId], null, []), ...validateArtDirection(artDirection, targets)];
if (issues.length) throw new Error(issues.join("\n"));
const result = {
  sourceProjectId: "cmumrwhor0031jdnknp010zyu", sourceAssetId: sourceId,
  scope: "人工编写并通过程序契约检查的 3 张头图 + 4 张详情图示范方案；尚未进行本方案的真实模型出图验收。",
  styleReferences: [{ id: "dark-editorial", role: "STYLE ONLY", reason: "黑白层次、边缘光与大字主次" }, { id: "cool-sculpture", role: "STYLE ONLY", reason: "筒状商品曲面受光与三维空间；不继承蓝色或参考文案" }],
  plan, artDirection,
  imagePrompts: artDirection.sections.map((art, i) => ({ sectionId: art.sectionId, aspectRatio: frames[i].kind === "HERO" ? "1:1" : "3:4", prompt: compileArtPrompt(plan, plan.sections[i], artDirection, art) })),
};
writeFileSync("docs/salonia-complete-page-plan.json", JSON.stringify(result, null, 2) + "\n", "utf8");
const md = [
  "# SALONIA 吹风机 · 完整详情页示范方案", "", "3 张头图 + 4 张详情图。基于当前项目原图人工设计，并通过实际生成流程使用的方案、分镜和提示词校验；本文件不是新生成成品，也不代表已经完成真实视觉验收。", "",
  `原始依据：[商品原图](${sourcePath})。现有项目和图片均保留，本方案没有触发收费请求。`, "",
  "## 设计主线", "", "**黑白有型，日常有序。** 石墨黑、暖白与一笔鼠尾草绿，统一摄影光线和字体家族。封面建立立体感，场景表达生活关系，局部负责看清商品，长页以产品档案收尾。避免七张图都用正面商品配上方标题。", "",
  "完整是信息任务完整，不是用未知参数填满模板。现有依据适合外观设计路线；功率、风速、负离子、噪声、速干时间、重量、电压、档位、配件、价格、认证和售后均不编写。若之后补齐这些信息，应将相应展示模块升级为有依据的功能说明，而不是增加空白屏。", "",
  "## 依据与边界", "", ...evidence.map(e => `- ${e.claim}`), "",
  "允许斜侧、俯拍和新的摄影环境，保留可辨识形状与连接关系。没有证据时不画内部结构、折叠演示、未知插头或风口细节；选择机位或裁切避开这些具体问题。", "",
  "## 七张图的阅读路径", "", "| 图片 | 信息任务 | 镜头 | 主文案 |", "| --- | --- | --- | --- |", ...frames.map(f => `| ${f.id} · ${f.kind === "HERO" ? "头图" : "详情"} | ${f.question} | ${f.view} | ${f.copy[0].replaceAll("\n", " / ")} |`), "",
  ...frames.flatMap(f => [`## ${f.id} · ${f.title}`, "", `**任务：** ${f.task}`, "", `**定稿文案：**`, "", ...f.copy.map(s => `> ${s.replaceAll("\n", "  \n> ")}`), "", `**镜头与主体：** ${f.camera} ${f.subject}`, "", `**布景与光影：** ${f.background} ${f.lighting}`, "", `**文字与装饰：** ${f.type} ${f.textLayout} ${f.accent} ${f.graphic}`, ""]),
  "## 连续长页与验收", "", "详情连接关系：D1 底 → D2 顶、D2 底 → D3 顶、D3 底 → D4 顶，统一为 **#F2F0E9**。每处终端全宽约 2% 自然融入平色，色彩和光影变化在屏内完成。文字、硬阴影、描边和商品不横跨切口，不靠加白色间距掩盖断层。", "",
  "- 缩略图：H1 先认出吹风机，再识别主题；H2 与 H1 的景别和布局明显不同。", "- 375px 宽度：正文与局部标签可读，标签确实指向对应部位，无密集小字。", "- 商品保持：不新增端口、档位文字、配件；标识、筒身、手柄和挂环不变形。", "- 完整长页：四屏按定位 → 细节依据 → 生活情境 → 选购档案连接；无重复页脚或外框。", "- 每图最多一次自动修正，仍有问题保留并标记；继续其他图片，整套检查不追加付费出图。", "",
  "## 研究来源与采用方式", "",
  "[Shopify 产品页实践](https://www.shopify.com/blog/product-page)强调清楚的产品呈现、信息与使用情境；本方案据此区分封面、场景和选购信息。[Amazon 产品摄影指南](https://sell.amazon.com/blog/product-photos)讨论不同视角与生活方式摄影；这里落实成五种明确机位。[Amazon A+ 内容设计指南](https://sell.amazon.com/blog/a-plus-content-design-guide)提供图文、规格、对照与问答模块思路；只采用有事实依据的模块，不复制其平台格式，也不把缺失参数或虚构评价画进图里。", "",
  "结构化方案与七份最终出图提示词见 [salonia-complete-page-plan.json](./salonia-complete-page-plan.json)。", "",
].join("\n");
writeFileSync("docs/salonia-complete-page-plan.md", md, "utf8");
console.log("SALONIA plan validated: 3 HERO + 4 DETAIL, 5 viewpoints, 3 shared seams, 7 compiled prompts.");
