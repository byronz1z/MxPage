# 模型设置与中转站兼容

只需填写服务地址、API Key 并选择模型，无需选择协议或 JSON 兼容模式。已配置服务的模型选择会自动保存；保存本身不调用模型。请等待“已保存”；失败会恢复上次保存值。首次添加服务仍使用“探测并保存”。刷新模型目录保留仍在目录中的手动选择，不再补入服务未返回的预设模型。

文本生成模型负责规划、文案和分镜；图像识别模型负责商品识别与质检；生成和编辑使用各自的图像模型。带图片的规划需要文本模型具备视觉输入能力。未选择、不可用或能力不匹配会停止并提示，不会静默换模型。

新任务、重新生成、编辑和翻译采用保存后的设置。已创建的批次、排队操作和暂停任务保留创建时的模型及协议快照；继续任务不会切换到新模型。切换到不同服务后，应切回原服务恢复原任务。历史任务保持原模型，缺少协议快照时仍按 Chat Completions 执行。

## Sub2API 与其他兼容中转站

系统优先使用官方接口格式，自动完成以下检查：

- 文本与识图自动支持 **Responses、Chat Completions、Anthropic Messages、Gemini generateContent**。通用服务优先 Responses + 严格 JSON Schema；Anthropic、Google 官方地址优先各自原生格式。保留已有有效兼容结果，不因升级重新探测。
- 探测请求明确收到接口不支持或接口不存在时，才检查下一个协议；明确拒绝结构化输出格式时，OpenAI 格式依次检查 JSON Object、提示词 JSON，原生格式检查提示词 JSON。所有模式都在本地校验结果，不因服务显示名称猜测协议。普通文本支持四种协议的 JSON/SSE 完整响应；断流不视为完成。
- 结果按服务地址、模型和当前凭据指纹保存；API Key 本身不入库。文本、识图选择相同模型时合并检查；具备视觉能力的模型带一张内置小图验证输入。模型、地址或 API Key 变化后，首次创建新操作时自动检查，再保存任务快照。

兼容尝试只用于有次数和时间上限的轻量连接检查，可能产生少量文本/识图 token 费用。鉴权、限流、模型不存在、无效 Schema、空响应、超时或断流会停止，不继续尝试。已确认配置的正式业务请求只发送一次；失败后不自动切协议、换模型、修复结果或重发。服务端能力变化后，可点击“探测并保存”重新自动检查。

地址可填写域名根、版本地址或代理前缀，例如 `https://gateway.example`、`https://gateway.example/v1`、`https://gateway.example/openai/v1`；不要填写完整的 `/responses` 或 `/chat/completions` 操作地址。

图像自动选择标准 `/images/generations`、`/images/edits`、Gemini 原生或既有 `/google` 代理路径，以及下述 EvoLink 异步任务接口。标准 Images 支持参考图 multipart 及 URL/Base64 返回。已成功保存的每模型调用方式优先；升级前近期成功记录也用于保留原路径。其次采用模型目录明确声明的受支持端点或已核实的官方参数描述，未知服务保持既有标准路径，不通过付费生图试探接口。

Agent 的原生工具能力独立检查，不能用结构化 JSON 成功代替。Messages/Gemini 使用单次非流式原生请求，完成时发送文本事件；工具结果、图片和 Gemini 不透明签名可跨检查点恢复。Chat/Responses 保留流式输出。模型列表支持 OpenAI/Anthropic 与 Gemini 返回格式，保留服务原始模型 ID。

仅开放 Responses 图像工具、私有未描述的异步协议以及需要额外操作参数的专用模型仍会明确提示，不能保证任意私有 API 自动可用。不同 Sub2API 版本与上游账号开放能力不同，通用协议测试通过不等于特定站点已经实测。

API 监控分别显示请求模型、上游返回模型、协议和端点。超时、断流或结果不确定时，原有检查点保留，需用户明确重试。

## CloseAI 路径

根据 [CloseAI 快速接入文档](https://doc.closeai-asia.com/tutorial/library.html)，OpenAI 入口是 `/v1`，Claude 原生入口是 `/anthropic`，Gemini 原生入口是 `/google`。只填写 `https://api.openai-proxy.org` 或其 `/v1` 地址时，新的文本、识图和 Agent 工具兼容检查若选择原生协议，会使用 `/anthropic/v1/messages` 或 `/google/v1beta/models/{model}:generateContent`。选定前缀进入每模型缓存和任务快照；旧缓存和缺少该字段的旧快照保留原路径。自定义代理前缀、其他站点和原有 OpenAI 路径不改写，也不会在业务失败后换路径重发。

GPT Image 仍使用 `/v1/images/generations`、`/v1/images/edits`，模型发现仍读取 `/v1/models`。协议接入文档与价格页都不能证明当前密钥的目录包含某个图像模型。可通过“仅刷新模型列表”读取并保存目录，不执行连接或生图检查；缺失的模型不会凭旧快照或型号名称补入。这里的路径修复不代表已经解决具体账号的目录缺失，也不新增 Vertex 协议。自动测试使用模拟上游；2026-10-20 另行完成部分真实账号验收，具体模型和操作见[真实验收记录](provider-live-acceptance.md)。

## EvoLink 异步图像

官方 API 地址 `https://api.evolink.ai`（也可带 `/v1`）按随代码维护的模型接口描述自动适配，不再限定两个型号。目录来源链接保存在 `lib/ai/catalog/evolink-images.json`，涵盖 GPT Image、Grok Image、Krea、Nano Banana / Gemini Image、Qwen Image、Seedream、Wan Image、Z Image。参考 [GPT Image](https://evolink.ai/docs/en/api-manual/image-series/gpt-image-2.5/gpt-image-2.5-image-generation) 与 [Seedream](https://evolink.ai/docs/en/api-manual/image-series/seedream/seedream-5.0-pro-image-generate) 官方说明。Midjourney 专用操作、分层输出等不能按单图工作流调用，会在上传或计费前提示。已有成功路径、旧快照优先，其他主机不会因为模型同名而调用 EvoLink 文件服务。

- 本地参考图和支持的蒙版通过官方 [Base64 文件接口](https://evolink.ai/docs/en/api-manual/file-series/upload-base64) 上传到 `files-api.evolink.ai`，取得可访问地址；文件服务文档规定 72 小时过期及账号配额。参考图数量、必填参数、蒙版及提示词长度按模型校验；缺少明确数量上限时最多传 16 张。纯文生图模型拒绝参考图。只向 `/v1/images/generations` 提交一次，模型 ID 不变；`auto` 质量保留服务端默认值。
- 按各模型描述发送参数，不向 Seedream / Nano Banana 发送 GPT Image 专属的 `high` 等质量值：分辨率档位按低、中、高映射到该模型支持的档位，高/极高/最高采用最高档。未支持的默认 PNG 参数省略；明确要求的透明背景、非默认格式或蒙版若不受支持则提前提示。受限比例使用文档中的最近比例，明确指定且不支持的像素尺寸不会被偷偷改写。
- 取得任务编号后先保存，再通过 [任务查询接口](https://evolink.ai/docs/en/api-manual/task-management/get-task-detail) 读取结果。V4 详情页和批量翻译在断连、超时或重启后继续查询原任务，不需要勾选付费重试；已知任务即使勾选也不会被重复创建。上游明确失败后，才允许显式重试创建新任务。没有取得任务编号的断连仍按结果不确定处理。
- 新任务快照包含每个图像模型的协议和参数描述；旧任务不批量改写，缺少新字段时保留原路由。刷新模型目录保留同模型的兼容记录，各记录按地址和凭据指纹校验。单图生成、编辑及翻译也记录上游编号，API 监控可查询；这些新操作不能代替 V4 或批量翻译的“继续任务”。
- 图片结果仍保存到本地作品。接口返回 404/405 时停止后续图片调度；已发出的并行请求正常收尾，不隐式切协议、换模型或重新提交。停止后不得因参考图上传完成而再发起新生图。

模拟测试覆盖上传、多参考图、蒙版、原始模型 ID、异步结果、任务编号保存、断流、查询超时、明确失败、恢复和停止。未进行真实账号付费生图验收；此适配不代表 EvoLink 的所有模型或私有代理均已验证。

## 升级与测试

执行 `npm run prisma:generate`、`npm run prisma:migrate`，再重启服务；增量迁移新增协议字段并将当前服务配置启用自动兼容，不改写历史任务。已有协议快照保持不变，旧任务缺少快照时沿用 Chat Completions。Windows 下生成 Prisma 前应停止占用其引擎文件的开发服务。

运行 `npm test`、`npm run typecheck`。设置页回归为 `node tests/browser/provider-settings.cjs`，使用临时数据库、独立构建目录和模拟响应，不调用真实模型。
