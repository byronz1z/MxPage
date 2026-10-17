import type { PlatformOption } from "@/types/domain";

export type CommerceScene =
  | "hero_search"
  | "feature_proof"
  | "lifestyle"
  | "material_closeup"
  | "specification"
  | "trust"
  | "campaign"
  | "summary";

export const commerceContentModuleIds = ["need", "selling_points", "scenarios", "details", "specifications", "trust", "usage", "closing"] as const;
export const commerceContentModuleLabels: Record<typeof commerceContentModuleIds[number], string> = {
  need: "需求与痛点", selling_points: "卖点与证据", scenarios: "使用场景", details: "结构、外观与质感细节",
  specifications: "参数与规格", trust: "购买保障", usage: "使用指南与注意事项", closing: "购买理由与行动引导",
};

export function buildCommerceContentStandard() {
  return [
    "整套详情页内容标准（按用户提供的文案模板、11类生图模板与10屏KV参考提炼）：",
    "先完成购买决策内容，再选择呈现方式。优化目标是商品吸引力、信息完整、证据清楚、细节可见、移动端可读；不以字少、道具少、留白多作为质量标准。",
    "1. 需求与痛点 need：说明面向谁、何时使用、有什么真实需求，连接商品与生活；有依据时策划约100字完整叙述，分配到适合的图文模块，不用一句空泛口号代替。",
    "2. 卖点与证据 selling_points：按特性 Feature—优势 Advantage—用户收益 Benefit组织，优势必须有证据，收益不能变成未经验证的性能承诺。资料充足时组织5—8个卖点，每点短标题加30—50字解释，并安排可见证明；证据不足时保留真实数量并说明缺口，不凑卖点。",
    "3. 使用场景 scenarios：资料允许时规划3—5个不同场景，写清环境、动作、商品角色与生活价值；完整策划文案可为每场景100—150字，再分配到多屏或场景组图，不能简单删除成标题。场景选择可以创作，商品功能不能虚构。",
    "4. 细节 details：覆盖有素材支撑的结构、外观、表面纹理、工艺或功能部位；安排不同部位的可辨认大特写、局部放大、指示线、短说明或信息模块。未知材质不妨碍展示真实表面纹理，不能用重复整杯/整机照片替代细节。",
    "5. 参数与规格 specifications：已提供的参数标签、数值、单位、包装清单、尺码表全部保留，尺寸表的每列每格均可读；解释不得改写数值。缺失参数记为待补充，不能编造，也不能把其他有依据的内容一并删掉。",
    "6. 购买保障 trust：展示已提供的品质证明、认证、服务、售后、真实评价或活动信息；没有资料就列出缺口，不套用示例中的销量、好评率、保修期、赠品或倒计时。",
    "7. 使用指南 usage：按已提供说明呈现使用步骤、搭配、护理及注意事项；产品特定温度、适配、清洗或安全要求无依据时待补充，不能猜测。",
    "8. 收口 closing：总结已证实的购买理由，给出与用途相符的行动引导。普通选购/了解详情不依赖促销；优惠、紧迫感、稀缺性必须有真实资料。",
    "完整策划可比较3个标题方案（中文每个30字内）和3个CTA方案，再选定适合的可见文案；候选方案不能全部堆到一张图。",
    "这些是内容职责，不是强制一项一屏。用户选择的图片数量和语言优先；少屏可用多模块、组图、标注或表格承载，仍须可读。容纳不下时明确列出缺口或建议加屏，不能静默删减，也不能未经用户选择增加出图数量。",
    "完整商品详情与单张海报、小红书笔记、翻译/局部编辑的范围不同：按当前任务应用标准，不把参考中的10张、9:16、双语或LOGO硬套到所有任务。已有品牌才展示品牌元素，语言以用户选择为准。",
  ].join("\n");
}

type PlatformProfile = {
  label: string;
  framing: string;
  copy: string;
  cta: string;
  guardrails: string;
};

const platformProfiles: Record<PlatformOption, PlatformProfile> = {
  general_ecommerce: {
    label: "通用电商详情页",
    framing: "移动端优先，首屏快速识别商品，详情页按购买决策顺序展开",
    copy: "标题短而明确，卖点用特性-收益-证据表达；参数和售后信息必须可读",
    cta: "提供自然的选购或了解详情引导；促销型 CTA 只使用真实活动，不编造价格、销量、认证或赠品",
    guardrails: "控制信息密度，避免把每一屏做成重复海报",
  },
  taobao_tmall: {
    label: "淘宝 / 天猫商品详情",
    framing: "3:4 详情模块与 1:1 首图并用，视觉从首屏卖点过渡到参数、服务和收口",
    copy: "中文短标题、标签和参数表优先，适合快速扫读；信息层级清楚，安全边距充足",
    cta: "CTA 克制，促销、规格、运费和售后只使用已提供内容",
    guardrails: "保持连续详情页边缘色，禁止模拟淘宝 UI、按钮或水印进入图片",
  },
  pinduoduo: {
    label: "拼多多商品详情",
    framing: "高对比首屏、明确卖点和紧凑信息模块，先解决价格与功能疑问再展示场景",
    copy: "短句、数字和可验证参数优先；每屏只保留一个核心购买理由",
    cta: "不得制造拼团、券、库存或限时数字；真实优惠由用户输入",
    guardrails: "避免廉价贴纸堆叠、过多爆炸字体和无证据对比",
  },
  xiaohongshu: {
    label: "小红书种草图文",
    framing: "3:4 竖版、生活方式场景和真实使用动作，画面留出自然阅读空间",
    copy: "语气亲和具体，强调使用体验和选择理由；少用硬广式口号和大段参数",
    cta: "使用轻量行动引导，不编造博主、评价、销量或热搜背书",
    guardrails: "避免过度棚拍、营销贴纸和平台 UI；人物与产品比例自然",
  },
  douyin_ecommerce: {
    label: "抖音电商内容图",
    framing: "前 1 秒可识别的强主体和动作瞬间，画面节奏清晰，适合 9:16 竖屏",
    copy: "一句话利益点配一个可见证明，文案短、字号大、对比清晰",
    cta: "只在输入真实活动时展示购买引导，不虚构直播间、倒计时和库存",
    guardrails: "禁止把视频字幕、按钮或水印当作商品详情图固定元素",
  },
};

const sceneProfiles: Record<CommerceScene, string> = {
  hero_search: "搜索首图：完整展示商品，建立类别、差异和第一购买理由；主体清楚突出，按任务选择纯净摄影、生活氛围或信息型主图，背景与道具服务商品。",
  feature_proof: "功能证明：放大真实结构、动作或接口，用标注和局部对比说明一个可验证卖点，标注必须指向真实部件。",
  lifestyle: "生活场景：把商品放进真实使用环境，用人物动作、尺度和光线展示它如何解决具体生活问题，不把道具写成商品功能。",
  material_closeup: "材质工艺：用微距、侧光和真实纹理展示材料、接缝、表面或工艺细节，不把可见外观夸大成性能承诺。",
  specification: "规格信息：保留所有已知参数、单位、包装内容和尺寸表格；使用清晰信息排版，不能删减或重写数值。",
  trust: "购买保障：只展示已提供的认证、售后、包装或品牌事实；未知信息留空，不用通用信任话术填充。",
  campaign: "活动传播：把真实活动信息作为视觉层级的一部分，产品仍是主体；没有活动信息时退化为差异化卖点海报。",
  summary: "收口总结：回顾 2-3 个已证实购买理由，给出克制的下一步提示，避免重复首图和空泛口号。",
};

export function inferCommerceScenes(sectionType: string, title = "", goal = ""): CommerceScene[] {
  const text = `${sectionType} ${title} ${goal}`.toLowerCase();
  if (/spec|参数|尺寸|规格|size|measurement/.test(text)) return ["specification"];
  if (/material|材质|工艺|纹理|面料|texture/.test(text)) return ["material_closeup"];
  if (/scenario|场景|使用|通勤|卧室|户外|lifestyle|生活/.test(text)) return ["lifestyle"];
  if (/trust|保障|售后|认证|品牌|service|brand/.test(text)) return ["trust"];
  if (/campaign|活动|节日|联名|限量|促销/.test(text)) return ["campaign"];
  if (/summary|总结|收口|cta|购买/.test(text)) return ["summary"];
  if (/close|特写|细节|feature|卖点|功能|annotation/.test(text)) return ["feature_proof"];
  return [sectionType.toLowerCase() === "hero" ? "hero_search" : "feature_proof"];
}

export function buildCommerceSystemPrompt(platform: string, scenes: CommerceScene[] = ["hero_search"]): string {
  const profile = platformProfiles[platform as PlatformOption] ?? platformProfiles.general_ecommerce;
  const sceneText = scenes.map(scene => sceneProfiles[scene]).join("\n");
  return [
    `COMMERCE SYSTEM · ${profile.label}`,
    `平台构图：${profile.framing}`,
    `文案规则：${profile.copy}`,
    `行动引导：${profile.cta}`,
    `平台边界：${profile.guardrails}`,
    "统一生产原则：商品原图、已确认参数和用户提供的事实共同构成证据；每屏有明确购买问题，同时可包含标题、解释、细节证明与相关信息模块。",
    "视觉原则：先确定主体、镜头、场景、光线、信息层级和安全边距，再写提示词；保持整套配色、光线、字体层级和边缘衔接一致。统一视觉系统不等于每屏同一构图：全景、真实场景、大特写、局部标注、信息图和参数表按内容穿插。",
    "视觉取舍：保留用户明确喜欢的场景氛围、细节密度和信息组织。允许有依据的标签、图标、局部放大、指示线、组图和道具；它们要帮助理解商品。不要擅自改成全套纯色背景、一屏一句话、大留白或重复商品照；只有用户选择极简时才采用这种风格。",
    "合规原则：不虚构价格、销量、认证、性能、材质、尺寸、赠品、评价、库存或竞品结论；未知字段进入补充信息，不写进可见文案。",
    "图片原则：保留真实几何、结构、接口、开口、按键、线缆、重力和阴影；不生成漂浮、穿模、反向气流、断裂线缆或无依据的产品部件。",
    "排版原则：可见文字必须来自 canonical copy；数字与单位不可拆分，参数表和尺寸表完整保留，移动端优先保证可读性。",
    buildCommerceContentStandard(),
    "本任务场景：",
    sceneText,
  ].join("\n");
}

export function buildCommercePromptStrategy(platform: string) {
  const profile = platformProfiles[platform as PlatformOption] ?? platformProfiles.general_ecommerce;
  return {
    platform: profile.label,
    scenes: Object.entries(sceneProfiles).map(([id, instruction]) => ({ id, instruction })),
    systemPrompt: buildCommerceSystemPrompt(platform, ["hero_search", "feature_proof", "lifestyle", "material_closeup", "specification", "trust", "summary"]),
  };
}
