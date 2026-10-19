# 仓库介绍与检索信息维护

更新日期：2026-10-20。本文面向维护者，记录仓库 SEO 与生成式搜索可读性（GEO）的维护方式。发布目标为 `https://github.com/ziguishian/MxPage`，不是同一工作区中其他 Git remote。

## 产品定位

- 中文：MxPage · 开源 AI 电商详情页生成器。
- 英文：MxPage — Open-source AI E-commerce Product Image & Detail Page Generator。
- 核心受众：电商运营、跨境卖家、设计师、内容创作者和自部署团队。
- 首要任务：从商品参考图生成主图与详情图片，再完成编辑、翻译和导出。
- 首页入口：下载、实际案例、快速开始、FAQ；技术与架构信息放在后面。

## GitHub About

简介：

> 开源 AI 电商图片工作台：商品主图与详情页、批量图片翻译、小红书图文、LangGraph Agent。支持 Windows / macOS 和本地部署，使用自己的模型 API。Open-source e-commerce image generator, translation & agent workspace.

网站入口指向 [最新 Release](https://github.com/ziguishian/MxPage/releases/latest)，使新访客能直接找到安装包。

主题只选择当前真实功能与技术栈，不添加未实现的平台、热门模型或无关产品名称。优先覆盖电商、商品图片、图片生成与编辑、小红书、批量处理、翻译、自部署和兼容 API。

本次读取远端时已有 20 个主题。待功能验收与源码推送完成后，建议将 `portable`、`workflow-automation` 替换为更准确描述新增能力的 `langgraph`、`model-context-protocol`，保留其余主题。最终列表：`ai-agents`、`batch-processing`、`deterministic-workflow`、`e-commerce`、`electron`、`image-editing`、`image-generation`、`image-translation`、`langgraph`、`macos`、`model-context-protocol`、`nextjs`、`openai-compatible`、`product-detail-page`、`product-images`、`product-photography`、`self-hosted`、`typescript`、`windows`、`xiaohongshu`。这段是发布配置，不代表尚未提交的远端修改已生效。

## 文档一致性

1. [README.md](../README.md) 是完整中文说明；[README.en.md](../README.en.md) 同步关键产品事实；[README.zh-CN.md](../README.zh-CN.md) 保留为中文入口。
2. [llms.txt](../llms.txt) 是可直接阅读的事实摘要和文档索引。它不是搜索收录要求，也不保证 AI 系统读取或引用；关键内容同时写在公开 README 中。
3. 每次发布同步检查版本、系统支持、张数上限、安装文件、模型前提、费用和数据流向。
4. 案例应标明输入背景、输出数量、来源与验收范围；单图提示词预览不能写成应用完成的整套成果。
5. 描述功能时区分图片生产与店铺发布、本地应用与离线模型，避免新用户误解。
6. README 顶部用“任务 → 入口 → 结果”表和直接下载/案例链接帮助定位；中英文 FAQ 对齐费用、数量、协议、翻译、恢复与数据流向。`llms.txt` 提供同一组可核实的简短答案及来源。
7. 仓库 `main`、已发布安装包、模拟回归和真实接口验收分别标注。没有实测的模型、桌面控制能力或平台不写成已验证。

## 本地应用与公开索引

应用的 `/` 是带个人任务的工作区，`/agent` 是个人会话页，均不适合作为搜索入口。它们和其他工作区页面继承 `noindex`，站点地图不包含工作区 URL；即使配置 `NEXT_PUBLIC_SITE_URL`，也只允许抓取静态 `/llms.txt`。该环境变量不会创建公开官网。robots/noindex 不是访问控制，公开部署仍需独立鉴权。

本轮没有部署独立官网、提交 Search Console 或购买推广；GitHub 发现主要依赖公开仓库正文、主题、案例和文档链接。若以后有实际官网域名，再为公开介绍页配置 canonical、站点地图、分享卡片和与页面一致的结构化数据，不应把个人工作区或虚构评价写入其中。

## 观察效果

在 GitHub Insights → Traffic 中人工记录更新日期附近的访问量、独立访客、克隆数、来源和热门内容，隔一段时间与同长度窗口比较。结合 Release 下载量和新用户 Issues 判断介绍是否帮助用户开始使用。不要将 Star 数或短期波动直接等同于搜索排名提升。

可人工检查品牌词「MxPage」与自然需求词「开源 AI 电商详情页生成器」「AI e-commerce product image generator」的搜索结果，以及 AI 回答是否正确提及下载方式、费用和支持范围。记录查询、日期和引用 URL；检索结果随系统、地区与时间变化。

## 依据与边界

[GitHub Topics 文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)说明，相关主题有助于用户按用途发现项目。

[Google AI 搜索说明](https://developers.google.com/search/docs/appearance/ai-features)强调可访问的文本、内部链接和有用内容；AI 搜索不要求额外的 AI 文件或特殊结构化标记，收录与展示也不作保证。因此仓库优化以清晰介绍、真实案例、常见问题和可维护的产品事实为主。

GitHub 托管页面的索引控制、HTML 元信息和抓取策略由平台管理。仓库内添加 meta、JSON-LD、robots.txt 或 sitemap 文件，不等于这些设置已应用到 GitHub 仓库网页。若未来发布独立官网，应再在实际站点中配置与验证。
