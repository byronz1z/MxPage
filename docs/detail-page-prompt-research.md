# 详情页提示词设计依据

参考 OpenAI [Image prompting](https://developers.openai.com/api/docs/guides/image-prompting) 和 Baymard [Product images and descriptive text](https://baymard.com/research-articles/product-images-descriptive-text)。检索日期：2026-09-28。

落地在 `lib/detail-runs/creative-rules.ts`：逐图明确主体、角度、光线、场景、留白和准确文案；整套统一字体、色彩和光线；商品外观以参考图为准。详情模块分别承担外观、细节、使用情境、已确认规格等任务，避免同一卖点重复堆叠。图片与简短说明相互补充，不把全部说明塞入小字。

平台方向是产品设计建议，并非平台最新发布规范；通用选项默认保留。不存在保证成片质量的万能提示词。沿用逐张视觉检查与一次修正限制；错误文字、形变与虚构信息仍需人工核实。
