# MxPage · AI 电商详情页与商品图工作台

[简体中文](README.md) · [English](README.en.md) · [桌面版下载](https://github.com/ziguishian/MxPage/releases/latest) · [更新说明](docs/releases/v0.3.0.md) · [AI 文档索引](llms.txt)

[![Release](https://img.shields.io/github/v/release/ziguishian/MxPage)](https://github.com/ziguishian/MxPage/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/ziguishian/MxPage?style=social)](https://github.com/ziguishian/MxPage)
[![Desktop release](https://github.com/ziguishian/MxPage/actions/workflows/desktop-release.yml/badge.svg)](https://github.com/ziguishian/MxPage/actions/workflows/desktop-release.yml)

**MxPage 是由灵矩绘境维护的开源 AI 电商图片工作台。** 上传商品参考图，补充商品事实，选择平台、语言与图片数量，即可制作商品主图、完整详情页长图和小红书图文，也可以批量翻译已有商品图片。支持本地部署及 Windows、macOS 桌面运行。

v0.3.0 将详情页执行器重构为 **V4 确定性状态机 + 单次结构化模型请求**。任务调度、检查点、排版、停止与恢复由代码负责，不再使用 `@openai/agents` 或多轮工具调用。旧版本工作流保留查看和导出，新任务使用 V4。

## 主要功能

| 场景 | 功能 |
| --- | --- |
| 电商详情页 | 商品识别、购买价值规划、整套分镜、主图与详情图生成、手机样机预览 |
| 完整内容策划 | 需求与痛点、卖点与证据、场景、已知参数、使用说明和购买决策信息；未知事实先确认 |
| 多平台视觉 | 通用电商、淘宝/天猫、拼多多、抖音和小红书提示词，按类目与任务应用 |
| 批量处理 | 文件夹商品批次、全局任务队列、逐张保存、失败查看和继续操作 |
| 图片翻译 | 单张、多张、文件夹、多语言批量，固定提示词，不运行商品规划 Agent |
| 编辑与交付 | 逐图编辑、历史版本、原图/译图对照、分图 ZIP、完整详情长图 |
| 监控 | 当前阶段、文本及每张图片耗时、API 费用与稳定性图表、人民币费用估算 |
| 用户中心 | 头像与用户名、最近 12 个月消耗热力图、模型配置、外观与关于页面 |

详情任务支持 **3–10 张头图、4–20 张详情图**。平台预设用于内容与视觉制作，不会自动发布到平台，也不导出商城网站。

## 软件截图

以下为 **2026-10-17 本地运行的 v0.3.0** 实际截图，仅展示首页和效果页。效果页使用最新的渐变色杯装蜡烛作品，可查看手机预览、逐图编辑、文本与每张图片耗时。

**首页 · 上传商品开始创作**

![MxPage v0.3.0 首页](docs/screenshots/v0.3.0/home.jpg)

<details>
<summary>效果页 · 手机预览、图片编辑与任务耗时（展开截图）</summary>

![MxPage v0.3.0 最新蜡烛作品效果页](docs/screenshots/v0.3.0/editor-phone.jpg)

</details>

[查看两张完整截图与拍摄说明](docs/screenshots/README.md)

## 实际生成案例

以下图片来自本地已生成的作品，保留原始画面与文案；展示文件只做等比缩放、压缩和按页面顺序拼接。每组均提供**商品原图、全部头图、分屏详情图和完整详情长图**，点击案例可查看大图。

### 最新本地作品

| 渐变色杯装蜡烛 | 香薰炉 | 木纹外观桌面雾化器 |
| --- | --- | --- |
| [![渐变蜡烛头图](docs/examples/gradient-candle/hero-1.jpg)](docs/examples/gradient-candle/README.md) | [![香薰炉头图](docs/examples/aroma-burner/hero-1.jpg)](docs/examples/aroma-burner/README.md) | [![木纹雾化器头图](docs/examples/wood-diffuser/hero-1.jpg)](docs/examples/wood-diffuser/README.md) |
| 4 张头图 + 6 屏详情 | 4 张头图 + 6 屏详情 | 3 张头图 + 4 屏详情 |
| [完整长图 · 1080 × 8640](docs/examples/gradient-candle/detail-long.jpg) | [完整长图 · 1080 × 8640](docs/examples/aroma-burner/detail-long.jpg) | [完整长图 · 1080 × 5760](docs/examples/wood-diffuser/detail-long.jpg) |

**渐变蜡烛 · 6 屏详情概览**

[![渐变蜡烛完整六屏详情概览](docs/examples/gradient-candle/detail-overview.jpg)](docs/examples/gradient-candle/detail-long.jpg)

**香薰炉 · 6 屏详情概览**

[![香薰炉完整六屏详情概览](docs/examples/aroma-burner/detail-overview.jpg)](docs/examples/aroma-burner/detail-long.jpg)

**木纹雾化器 · 4 屏详情概览**

[![木纹雾化器完整四屏详情概览](docs/examples/wood-diffuser/detail-overview.jpg)](docs/examples/wood-diffuser/detail-long.jpg)

这三组作品使用 `gpt-6-luna` 与 `gpt-image-2.5-flare`，请求画质为 `auto`。记录保留 `PARTIAL` 质检状态；部分规格来自用户选中的模型候选，属于演示输入，不能作为实测商品参数。案例页保留具体来源和待核对项。

### 茶器与马克杯长图

| 金棕纹理带盖茶器 | 马克杯 · 完整内容重测 | 马克杯 · Round2 |
| --- | --- | --- |
| [![茶器头图](docs/examples/tea-set/hero-1.jpg)](docs/examples/tea-set/README.md) | [![马克杯完整重测头图](docs/examples/mug-complete/hero-1.jpg)](docs/examples/mug-complete/README.md) | [![马克杯 Round2 头图](docs/examples/mug-round2/hero-1.jpg)](docs/examples/mug-round2/README.md) |
| 3 张头图 + 8 屏详情 | 3 张头图 + 8 屏详情 | 3 张头图 + 4 屏详情 |
| [完整长图 · 1080 × 11520](docs/examples/tea-set/detail-long.jpg) | [完整长图 · 1080 × 11520](docs/examples/mug-complete/detail-long.jpg) | [完整长图 · 1080 × 5760](docs/examples/mug-round2/detail-long.jpg) |

<details>
<summary>展开茶器与马克杯的详情页概览</summary>

**茶器 · 8 屏：需求、外观卖点、纹理、结构、场景、搭配、已知信息与收尾。**

[![茶器八屏详情概览](docs/examples/tea-set/detail-overview.jpg)](docs/examples/tea-set/detail-long.jpg)

**马克杯完整重测 · 8 屏：沿用暖木与奶油棕风格，展开正文、局部说明、场景和信息表。**

[![马克杯八屏完整详情概览](docs/examples/mug-complete/detail-overview.jpg)](docs/examples/mug-complete/detail-long.jpg)

**马克杯 Round2 · 4 屏：保留早期场景与配色版本，便于比较内容展开前后的差异。**

[![马克杯 Round2 四屏详情概览](docs/examples/mug-round2/detail-overview.jpg)](docs/examples/mug-round2/detail-long.jpg)

</details>

这三组实测使用 `gpt-6-luna` 与 `gpt-image-2.5-flare` 的 `low` 画质。它们展示实际输出，不代表全部通过商品一致性或文案验收。[全部案例、原图与来源说明](docs/examples/README.md)。

## 下载与首次使用

在 [GitHub Releases](https://github.com/ziguishian/MxPage/releases/latest) 选择对应系统：

| 系统 | v0.3.0 文件 | 使用方式 |
| --- | --- | --- |
| Windows x64 | `MxPage-0.3.0-windows-x64.zip` | 完整解压后运行 `MxPage.exe` |
| macOS Apple Silicon | `MxPage-0.3.0-macos-arm64.zip` | 解压打开 `MxPage.app`，也可移到“应用程序” |
| macOS Intel | `MxPage-0.3.0-macos-x64.zip` | 解压打开 `MxPage.app`，也可移到“应用程序” |

绿色包包含 Electron 和本地服务，**无需安装 Node.js**。不要单独复制 EXE 或移动 `.app` 内部文件。免安装不代表数据跟随程序目录移动：

- Windows 数据：`%APPDATA%/MxPage/`。
- macOS 数据：`~/Library/Application Support/MxPage/`。
- 更新前退出应用、备份数据目录，再替换程序文件。
- 包没有商业代码签名或 Apple 公证；macOS 使用 ad-hoc 签名。系统可能要求确认来源，Release 提供 `SHA256SUMS.txt` 校验文件。

首次运行：

1. 左下角头像 → **API 配置**，填写自己的 OpenAI 兼容服务地址与 API Key。
2. 使用合并后的探测入口发现模型并检查连接；右上角显示连接状态、图像模型及最近验证时间。
3. 本版详情工作流选择探测到的 **GPT-6 Luna / GPT Image 2.5 Flare** ID，不凭简称构造模型名；目前不把带日期后缀的模型当作替代项。服务需支持结构化 JSON 与图像生成/编辑。
4. 上传参考图和已知商品事实。补充信息逐题弹窗，提供三个具体候选和自行填写；候选须由用户确认，未知尺寸不自动视为实测值。
5. 先用少量图片、`low` 质量验证费用与效果，再扩大规模。API Key、额度和模型费用由用户自行提供。

图像质量、尺寸、格式和背景等参数按所选模型能力调整；发现模型不等于已经实测网关支持所有参数。

## V4 工作流

```text
PREPARE → PLAN → WAITING_INPUT（需要确认时）→ ART_DIRECTION
        → GENERATE → IMAGE_REVIEW → SET_REVIEW
        → COMPLETED / PARTIAL / FAILED
```

- **程序调度**：模型返回规划和分镜 JSON；首张 HERO 完成后处理其余图片，并发上限为 2。
- **本地排版**：以 `textBlocks[].text` 为正文来源，自动同步换行，保留参数、数字、单位和表格；自然润色不触发整套重做。
- **按检查点继续**：复用完成的规划、分镜、图片和检查；请求前记录 ID，心跳租约防止重复执行者覆盖状态。
- **不确定请求不自动重试**：超时、断网、无效响应可能已经计费，需用户明确授权重试。停止阻止后续调度，已发出的请求收尾并保存结果。
- **质检保留图片**：发现问题或检查未完成时保留图片并提示复核，不自动付费重画；用户明确修改后再执行编辑。
- **大套图分组检查**：12 张以内一次整套检查，更多图片使用重叠分组，已完成组可恢复复用。

补充选项、手动编辑、明确重试和大套图分组会增加调用次数。详见 [V4 恢复与可靠性](docs/workflow-v4-reliability.md)。

## 源码运行

需要 Git、**Node.js 24** 和 npm。

```bash
git clone https://github.com/ziguishian/MxPage.git
cd MxPage
npm ci
```

复制 `.env.example` 为 `.env`：PowerShell 使用 `Copy-Item .env.example .env`，macOS/Linux 使用 `cp .env.example .env`。设置自己的 `APP_SECRET` 后执行：

```bash
npm run prisma:generate
npm run prisma:migrate
npm run docs:sync
npm run dev
```

访问 `http://localhost:3000`。默认数据库位于 `prisma/dev.db`，图片和日志位于 `storage/`。生产运行使用 `npm run build`、`npm start`；先停止占用同一 `.next` 的开发服务。桌面构建使用独立 `.next-desktop`。

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL` | SQLite 文件位置 |
| `STORAGE_ROOT` | 图片、资产和监控记录目录 |
| `APP_SECRET` | 本地应用密钥，真实值不要提交 |
| `LOCK_BASE_URL` | 私有部署的固定模型网关，也兼容旧变量别名 |
| `NEXT_PUBLIC_SITE_URL` | 可选公开网址，启用首页 canonical、站点地图和索引；本地使用留空 |

这是个人本地工作台，公网共享前需配置访问控制、TLS 和数据隔离。`robots.txt` / `noindex` 是搜索提示，不是访问权限控制。

## 开发、测试与打包

```bash
npm test                 # 隔离数据库与模拟 Provider，不调用付费模型
npm run test:detail      # 工作流、恢复和排版重点测试
npm run typecheck
npm run build:desktop
npm run dist:green       # Windows 本机打包 x64 ZIP
npm run dist:mac         # macOS 本机打包当前架构 ZIP
npm run smoke:desktop   # 包内 SQLite、Prisma、sharp 与页面冒烟验证
```

[发布流水线](.github/workflows/desktop-release.yml)在原生 Windows、macOS ARM64、macOS Intel 环境构建并验证后，发布三个 ZIP 与 SHA256 校验文件。开发者数据库、密钥、测试输出和生成报告不进入发布包。

```text
app/                    页面与 API
components/             编辑器、手机预览、设置、监控和队列
lib/detail-runs/        V4 状态机、请求账本、检查点、租约和排版
lib/translation/        独立固定提示词翻译
lib/ai/                 Provider 适配与场景提示词
lib/monitor/            用量、计费、热力图和耗时
prisma/                 数据模型与迁移
desktop/                Electron 与本地服务启动
tests/                  隔离的单元及流程测试
```

代码助手应先读 [AGENTS.md](AGENTS.md)。[llms.txt](llms.txt) 是产品事实与文档索引，`npm run docs:sync` 同步到应用的 `/llms.txt`。历史设计文档继续保留，以当前代码、测试和 V4 文档为准。

## 费用、数据与限制

- 软件开源不代表模型免费。文本、图像生成、编辑、翻译与明确重试可能产生 Provider 费用。
- 监控区分接口金额、按用量估算、粗估和未计价记录。界面显示人民币，汇率和单价可编辑，不是实时结算账单。见[计费说明](docs/api-billing.md)。
- API Key 默认在当前浏览器本地存储，请求时传给本地服务，不存入项目数据库；桌面与普通浏览器的配置互相独立。
- 数据可保存在本地，但生成所需图片和描述会发送至配置的模型服务；不是完全离线生成器。
- 需人工核对商品外观、文案、翻译、参数和营销说法。选中的模拟候选保留来源记录，不能据此宣称实测、认证或未经核实的销售承诺。
- 旧工作流只保留查看/导出，不迁移到 V4；需要新流程请创建新任务。沿用现有 SQLite 模型和 API 路径。

## 文档与反馈

[更新说明](docs/releases/v0.3.0.md) · [恢复与可靠性](docs/workflow-v4-reliability.md) · [批量翻译](docs/translation-workflow.md) · [任务队列](docs/global-task-queue.md) · [计费](docs/api-billing.md) · [案例](docs/examples/README.md) · [问题反馈](https://github.com/ziguishian/MxPage/issues)

反馈请附版本、复现步骤与脱敏错误，不要提交 API Key 或私人商品资料。

## 品牌与许可

**灵矩绘境 · MxPage（MatrixInspire）** · Copyright © 2026 灵矩绘境。源码采用 [MIT](LICENSE)；素材及生成结果仍需遵守各自的权利与模型服务条款。


<summary>交流社区</summary>
<img width="360" alt="MxPage 交流二维码" src="https://github.com/user-attachments/assets/028cfd0b-a813-4655-9b49-aa9ab6619c7d" />

