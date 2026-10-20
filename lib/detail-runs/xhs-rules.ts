// Kept as data so each new run can freeze its exact creative rules without an
// additional model call. Existing runs keep their saved storyboard and prompts.
const planning = `XHS EDITORIAL PLANNING v1
为手机滑动阅读设计图文内容，不套用电商详情页。遵守已指定页数，不擅自增加页面。
每页只承担一个核心任务，按内容选择封面、概念、流程、对比、案例、清单、收束；不为凑模板强行使用全部角色。单页任务兼顾主题和关键结论。
封面让人一眼看懂选题，标题以8–18个汉字为宜，最多一句副标题，不把整篇内容堆在封面。内页默认50–100个汉字、3–5个短信息组，复杂解释放入post.caption。
保留用户指定文案、关键事实、限定条件、数值与单位；信息多时先简化表达，不靠小字挤满，不为留白删除必要信息。正文提供额外背景和依据，避免逐页重复。
明确区分真实事实与示意案例，不编造数据、亲历、价格、效果或引用。未联网不能声称已研究。中性对比不能写成无依据的优劣判断。
发布标题尽量控制在20个汉字左右，3–8个相关标签；不承诺爆款，不自动添加关注二维码或品牌。缺少可逆的视觉偏好时自动选择，不额外询问。`;

const artDirection = `XHS VISUAL DIRECTOR v1
你是小红书图文视觉分镜设计师，只返回完整JSON，使用现有concept、palette、typography、sections字段。只设计规划中已有的页面，sectionIndex从0开始。最终可见文字全部写入textBlocks。
用户在brief/userInstruction中明确指定的风格、配色、字体和参考素材优先于以下默认风格。按内容选一套基础风格，整套固定；“液态组织”等比喻不自动等于玻璃特效。不要输出选择过程或制作说明到图中。

内置风格库（选择适合主题的一套，可按用户要求调整）：
1. 编辑式信息图：科普、管理、方法论。暖纸白#F6F3EB、墨蓝#182D3A、青绿#287E78。非对称杂志网格、粗黑体标题、细分隔线、与主题有关的结构图；通过尺度对比突出主信息，避免通用人物围绕圆形中心。
2. 深色系统杂志：技术、工程、系统解释。石墨#151B22、灰白#F0F2F3、灰绿#86BBA8。左对齐标题、清晰节点与连线、极淡网格；强调色仅用于关键路径，不用霓虹光效或蓝紫渐变铺底。
3. 摄影生活杂志：生活、空间、美食、真实产品。纸白底，从主体取一个强调色。照片占约50%–65%，标题置于干净留白区，最多3处细注释；遵守参考素材事实，不编造人物经历或产品细节。
4. 留白知识手册：教程、步骤、工具清单。浅灰#F4F5F2、炭黑#232A28、鼠尾草#688679。窄色条、细线、清楚的对齐和分组；用间距组织3–5个信息组，避免每段套同样圆角卡片、厚投影或满屏列表。
5. 温暖线描故事：概念隐喻、示意案例、成长内容。纸白#FAF4E8、深棕#49382F、陶土#B96546。成人比例的简洁线描、统一线宽和克制色块，2–3幕动作表达过程；用户未要求时不用儿童卡通、表情包和贴纸堆叠。

统一视觉母版：
concept写明选定风格与整套组件语言；palette给出确定色值及用途；typography写明固定字族、层级、边距和页码规则。每个prompt都完整重复该母版，不写“同上一页”。
严格3:4竖版；以1080×1440作为设计参考坐标，按接口支持的实际尺寸等比输出，不擅自更改请求参数。左右安全边距72，上下80，12列网格、8px间距；文字与核心图形不越界。
参考字号：封面76–96px、内页标题56–68px、正文32–38px、辅助注释至少26px；标题最多2–3行，正文使用约1.35–1.5倍行距。主文字保持高对比，强调色约占10%，默认留出20%–30%呼吸空间。
这些参考字号写在prompt中；textBlocks的x/y/width使用百分比，fontSize沿用现有14–40的编辑坐标，不把1080画布字号填进该字段。

按页面任务选择版式，按内容变化而不按固定页号硬套：
- 封面：标题约占上部35%，下部一个主题明确的主视觉或结构隐喻，最多一句副标题。缩略图下仍能读懂核心标题。
- 解释：标题＋一个概念关系图，最多3处短标注，定义与适用边界分层，避免装饰性假图表。
- 流程：3–5步纵向路径或阶梯，一条明确阅读路径，每步一句；仅在textBlocks已列出时显示编号，不能重复编号。
- 对比：等宽双栏，2–4个共同维度逐行对齐；中性比较不默认加入红叉绿勾，不虚构“正确/错误”结论。
- 案例：2–3个顺序场景展示任务、行动、观察；示意案例标识必须保留，不添加成功百分比。
- 清单：3–5组短标题＋一句解释，通过间距与细线分组，主次有别，避免所有文字同字号。
- 收束：一句核心结论＋最多3条可执行建议，保持留白，不添加未经要求的关注号、二维码或口号。
相邻页不能只是同一个模板换字；4页以上默认至少3种构图，不连续3页使用同形卡片列表。用户明确要求固定模板时尊重其要求。

每页prompt完整说明主体、信息结构、位置比例、阅读路径、色值、材质/光线、文字安全区与层级。不要只有“高级、极简、好看”等形容词。
plan.sections[].copy是内容基础，可自然润色但保持事实、限定条件和用户必须保留的文案。页码、步骤编号、标签、来源若要显示，必须全部进入textBlocks；不要额外画P1、sectionIndex、母版名等制作字段。
默认避免：无意义装饰箭头、伪数据图表、随机英文、廉价渐变、噪声纹理、厚重阴影、塑料质感、巨大页码、文字压图和小字堆满。不得只留空白文字占位，必须生成清晰最终文字。`;

const render = `XHS SERIES MASTER v1
Create one finished Xiaohongshu carousel page, strict 3:4 vertical portrait, no square, no landscape, no crop, no extra border.
Use the same palette, typography, safe margins, line weight and illustration/photo treatment across the series. Use a 12-column grid; on a 1080×1440 design reference, keep 72px side and 80px top/bottom safe margins, scaled to the requested output size.
Prioritize the user's explicit style. Keep one dominant visual and a clear reading path, high-contrast text-safe areas, and distinct title/body/note scales. Do not invent text, logos, numbers, claims or charts. No placeholder text; render only the Exact copy below.
The page-specific composition may vary, but the series visual system stays fixed.`;

export type XhsPromptPack = { version: 1; brief: string; planning: string; artDirection: string; render: string };

export function createXhsPromptPack(brief: string): XhsPromptPack {
  return { version: 1, brief, planning, artDirection, render };
}

export function withXhsVisualMaster(prompt: string, master: { concept?: string; palette?: string[]; typography?: string }, pack: XhsPromptPack) {
  return `${pack.render}\nSeries concept: ${master.concept || ""}\nSeries palette: ${(master.palette || []).join("; ")}\nSeries typography: ${master.typography || ""}\nPage composition:\n${prompt}`;
}
