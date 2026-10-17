"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { billingRulesSchema, defaultBillingRules, type BillingRules } from "@/lib/monitor/billing";

export function BillingSettings({ initialRules }: { initialRules: BillingRules }) {
  const [rules, setRules] = useState(initialRules);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function save(next: BillingRules) {
    setBusy(true);
    try {
      const valid = billingRulesSchema.parse(next);
      const response = await fetch("/api/monitor/billing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valid) });
      const body = await response.json();
      if (!body.success) throw new Error(body.error?.message || "保存失败");
      setRules(body.data); toast.success("计费规则已保存"); router.refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "请检查单价"); }
    finally { setBusy(false); }
  }
  const lunaLabels = { input: "Luna 输入", cachedInput: "Luna 缓存读取", cacheWrite: "Luna 缓存写入", output: "Luna 输出" };
  const imageLabels = { textInput: "Image 文本输入", imageInput: "Image 图片输入", output: "Image 图片输出" };
  return <details className="rounded-2xl border bg-card p-5">
    <summary className="cursor-pointer font-medium">计费规则 · Luna / GPT Image</summary>
    <div className="mt-5 space-y-5">
      <div className="rounded-xl border bg-muted/30 p-4">
        <label className="block max-w-xs space-y-2 text-sm">人民币换算汇率（1 USD = CNY）<Input type="number" min="0.000001" max="1000" step="any" disabled={busy} value={Number.isNaN(rules.usdToCny) ? "" : rules.usdToCny} onChange={event => setRules({ ...rules, usdToCny: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">所有费用以人民币展示，按此汇率统一折算历史与新记录。默认 1 美元 = {defaultBillingRules.usdToCny} 元，仅用于估算，不是实时汇率；可按实际结算汇率调整。原始美元记录保留。</p>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">以下为原始计费单价，单位 USD / 100 万 tokens。默认采用 Standard 定价，支持 GPT-6 Luna、GPT Image 2、2.5 Flare / Sunburst 及日期版本；可按代理价格修改。应用内的批量队列仍按普通请求计费，不套用官方 Batch API 折扣。</p>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(lunaLabels) as Array<keyof typeof lunaLabels>).map(key => <label key={key} className="space-y-2 text-sm">{lunaLabels[key]}<Input type="number" min="0" step="any" value={Number.isNaN(rules.luna[key]) ? "" : rules.luna[key]} onChange={e => setRules({ ...rules, luna: { ...rules.luna, [key]: e.target.value === "" ? NaN : Number(e.target.value) } })}/></label>)}
        {(Object.keys(imageLabels) as Array<keyof typeof imageLabels>).map(key => <label key={key} className="space-y-2 text-sm">{imageLabels[key]}<Input type="number" min="0" step="any" value={Number.isNaN(rules.image[key]) ? "" : rules.image[key]} onChange={e => setRules({ ...rules, image: { ...rules.image, [key]: e.target.value === "" ? NaN : Number(e.target.value) } })}/></label>)}
      </fieldset>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-2 text-sm">缺少画质 / auto 时假定<Select value={rules.fallback.quality} onValueChange={quality => setRules({ ...rules, fallback: { ...rules.fallback, quality: quality as BillingRules["fallback"]["quality"] } })}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></Select></label>
        <label className="space-y-2 text-sm">缺少尺寸 / auto 时假定<Select value={rules.fallback.size} onValueChange={size => setRules({ ...rules, fallback: { ...rules.fallback, size: size as BillingRules["fallback"]["size"] } })}><option>1024x1024</option><option>1024x1536</option><option>1536x1024</option></Select></label>
        <label className="space-y-2 text-sm">每张输入图片假定 tokens<Input type="number" min="1" max="50000" step="1" value={Number.isNaN(rules.fallback.imageInputTokens) ? "" : rules.fallback.imageInputTokens} onChange={e => setRules({ ...rules, fallback: { ...rules.fallback, imageInputTokens: e.target.value === "" ? NaN : Number(e.target.value) } })}/></label>
      </fieldset>
      <p className="text-xs leading-6 text-muted-foreground">接口金额优先；有 usage 时按实际 token 估价，缺少 usage 时按文本长度、图像画质和像素面积粗估。失败且无用量的请求标记未计价，不视为免费。新记录保存当时的费率；旧记录缺少估价时按当前规则补估。保存规则不会改变生成参数。</p>
      <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => save(rules)}>{busy ? "保存中…" : "保存计费规则"}</Button><Button disabled={busy} variant="outline" onClick={() => setRules({ ...structuredClone(defaultBillingRules), usdToCny: rules.usdToCny })}>填入默认单价</Button></div>
      <p className="text-xs text-muted-foreground">默认价格核对日期：2026-10-16。<a className="underline" href="https://developers.openai.com/api/docs/models/gpt-6-luna" target="_blank" rel="noreferrer">Luna 官方定价</a> · <a className="underline" href="https://developers.openai.com/api/docs/models/gpt-image-2.5-flare" target="_blank" rel="noreferrer">Flare 官方定价</a> · <a className="underline" href="https://developers.openai.com/api/docs/guides/image-generation#costs-and-latency" target="_blank" rel="noreferrer">图像估算说明</a></p>
    </div>
  </details>;
}
