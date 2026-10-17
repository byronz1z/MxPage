# API 监控计费

监控页面 `/monitor/usage` 同时显示接口金额、估算金额及未计价记录数，费用统一以人民币（CNY / ¥）展示。用户中心的消耗热力图、费用图表和 GPT Image 输出估算共用同一汇率。筛选和翻页不会将汇总限制在当前页或最近 500 条记录。

在「API 监控 → 计费规则」中调整 `usdToCny`（1 USD 对应的人民币金额）。默认值 7 仅为可编辑的估算基准，不是实时汇率。保存后，历史与新记录均按所设汇率折算展示；原始 USD 金额、费率快照和 API 的 `costUsd` 字段保持不变。模型单价输入仍明确以 USD / 100 万 tokens 为单位，避免改变原始计费依据。图片输出估算读取同一份已保存单价。

## 计价顺序

1. 优先使用接口返回的 `cost_usd` 或 `cost` / `total_cost`（包括 `usage` 内字段）。零金额也有效；未注明币种时按 USD 处理，明确标注其他币种的金额不直接当美元使用。
2. 接口未返回金额时，按实际 `usage` 和当前配置单价估算。Luna 区分普通输入、缓存读取、缓存写入及输出；输出总量已包含推理 token，不重复相加。GPT Image 区分文本输入、图片输入及图片输出。
3. 成功请求缺少用量时粗估：文本使用长度估计，图片输出按模型、质量、尺寸及返回张数估计，参考图按可配置默认 token 数估计。Base64 图片响应不会作为文本计费。
4. 失败请求有用量仍计费；无金额也无用量则标为未计价，不视为免费。未支持模型亦标为未计价。

默认支持 GPT-6 Luna、GPT Image 2、GPT Image 2.5 Flare / Sunburst 及日期版本。Luna 的长上下文与明确的处理档位采用对应倍率。应用内的批量任务不是官方 Batch API，不自动享受 Batch 折扣。直接 Images API 不套用缓存折扣。工具、地区附加费、流式预览图片及代理自定义加价不在默认估算内。

## 保存与历史记录

- 规则文件：`STORAGE_ROOT/monitor/billing-rules.json`；监控页可修改单价及粗估假设。
- 新请求在 `api-usage.jsonl` 保存费率、计费依据、金额与规则版本，修改单价不会重算这些快照。
- 旧记录在读取时按当前规则补估，不改写原记录；缺少输入图片、质量、尺寸、系统提示或推理用量时可能低估，页面注明假设。
- 仅新增保存 token 数、图片数、质量、尺寸等计费元数据，不保存完整提示词、图片内容或 API Key。
- 估算用于监控预算，代理实际账单可能不同。

## 默认定价来源

核对日期：2026-10-16，Standard USD / 100 万 tokens。

| 模型 | 普通 / 文本输入 | 缓存读取 | 缓存写入 / 图片输入 | 输出 |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Luna | 0.10 | 0.01 | 0.125（缓存写入） | 0.50 |
| GPT Image 2 / 2.5 | 5.00 | 不用于直接 Images API | 8.00（图片输入） | 30.00 |

- [Luna 定价](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Flare 定价](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [图像生成费用说明](https://developers.openai.com/api/docs/guides/image-generation)

测试：`node --import tsx --test tests/billing.test.ts tests/translation.test.ts`。计费测试使用独立临时目录和 mock 响应，不调用付费模型。
