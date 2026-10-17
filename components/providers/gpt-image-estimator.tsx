"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { billingFamily, estimateImageOutputTokens, type BillingRules } from "@/lib/monitor/billing";
import { formatCostCny } from "@/lib/monitor/currency";

type Model = { modelId: string; label?: string | null };

function family(model: string): "gpt-image-2.5" | "gpt-image-2" | null {
  if (billingFamily(model) === "image25") return "gpt-image-2.5";
  if (billingFamily(model) === "image2") return "gpt-image-2";
  return null;
}

export function GptImageEstimator({ models, billingRules }: { models: Model[]; billingRules: BillingRules }) {
  const imageModels = useMemo(() => {
    // The same model can appear under multiple providers; estimates are per model ID.
    const uniqueModels = new Map<string, Model>();
    for (const item of models) {
      if (family(item.modelId) && !uniqueModels.has(item.modelId)) uniqueModels.set(item.modelId, item);
    }
    return [...uniqueModels.values()];
  }, [models]);
  const [model, setModel] = useState(imageModels[0]?.modelId ?? "gpt-image-2.5-flare");
  useEffect(() => {
    if (imageModels.length && !imageModels.some((item) => item.modelId === model)) setModel(imageModels[0].modelId);
  }, [imageModels, model]);
  const kind = family(model) ?? "gpt-image-2.5";
  const [quality, setQuality] = useState(kind === "gpt-image-2" ? "low" : "low");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const options = kind === "gpt-image-2" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh", "max"];
  const estimate = useMemo(() => {
    const tokens = estimateImageOutputTokens(kind === "gpt-image-2.5" ? "image25" : "image2", quality, `${width}x${height}`) ?? 0;
    return { tokens, cost: tokens * billingRules.image.output / 1_000_000 };
  }, [kind, quality, width, height, billingRules.image.output]);
  return <Card><CardHeader><CardTitle>GPT Image 输出估算</CardTitle><CardDescription>按模型、画质和尺寸估算图像输出 token 与单图成本。实际值以 API 返回的 usage 为准；不含文本、输入图片和 partial images。</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-2"><label className="space-y-2 text-sm">模型<Select value={model} onValueChange={(value) => { setModel(value); setQuality(family(value) === "gpt-image-2" ? "low" : "low"); }}>{imageModels.length ? imageModels.map((item) => <option key={item.modelId} value={item.modelId}>{item.label || item.modelId}</option>) : <option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option>}</Select></label><label className="space-y-2 text-sm">画质<Select value={quality} onValueChange={setQuality}>{options.map((value) => <option key={value}>{value}</option>)}</Select></label><label className="space-y-2 text-sm">宽度<Input type="number" min={16} max={3840} step={16} value={width} onChange={(event) => setWidth(Number(event.target.value) || 16)} /></label><label className="space-y-2 text-sm">高度<Input type="number" min={16} max={3840} step={16} value={height} onChange={(event) => setHeight(Number(event.target.value) || 16)} /></label><div className="rounded-xl border bg-muted/30 p-4"><p className="text-sm text-muted-foreground">估算输出 tokens</p><p className="mt-1 text-2xl font-semibold">{estimate.tokens.toLocaleString()}</p></div><div className="rounded-xl border bg-muted/30 p-4"><p className="text-sm text-muted-foreground">估算图像输出成本（人民币）</p><p className="mt-1 text-2xl font-semibold">{formatCostCny(estimate.cost, billingRules.usdToCny, 5)}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">每 100 万图像输出 token 折合 {formatCostCny(billingRules.image.output, billingRules.usdToCny)}；按 1 USD = {billingRules.usdToCny} CNY 估算。单价与汇率跟随 API 监控的计费规则。</p></div><p className="text-xs leading-5 text-muted-foreground md:col-span-2">尺寸必须满足官方约束：宽高为 16 的倍数、长宽比不超过 3:1、总像素数为 655,360–8,294,400。自定义尺寸的 token 数为近似值。</p></CardContent></Card>;
}
