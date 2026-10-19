"use client";
import { useEffect, useState } from "react";
import { Select } from "@/components/ui/select";
import { commonImageOptions, type ImageCapabilities } from "@/lib/ai/image-capabilities";
import { readApiResponse } from "@/lib/utils/request-error";

export function useImageCapabilities(roles = "hero,detail") {
  const [models, setModels] = useState<ImageCapabilities[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { if (document.visibilityState !== "hidden") void fetch(`/api/providers/image-capabilities?roles=${roles}`, { signal: controller.signal }).then(readApiResponse<ImageCapabilities[]>).then(setModels).catch(() => undefined); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [roles]);
  return models;
}
const labels: Record<string, string> = { auto: "自动 · 由模型决定", low: "低 · 快速预览", medium: "中 · 平衡", high: "高 · 精细", xhigh: "XHigh", max: "Max" };
export function ImageQualitySelect({ value, onChange, models }: { value: string; onChange: (value: string) => void; models: ImageCapabilities[] }) {
  const options = commonImageOptions(models, "qualities") || Object.keys(labels);
  return <Select value={value} onValueChange={onChange}>{!options.includes(value) && <option value={value} disabled>{value} · 当前模型不支持，请重新选择</option>}{options.map(q => <option key={q} value={q}>{labels[q] || q}</option>)}</Select>;
}
export function ImageCapabilitySummary({ models }: { models: ImageCapabilities[] }) {
  return <div className="space-y-1 text-xs leading-5 text-muted-foreground">{models.map(model => <p key={model.modelId}>
    {model.label}：{model.evidence === "documented" ? "参数依据接口文档" : "参数能力待确认，保留兼容选项"}；{model.routeVerified ? "此服务曾成功返回图片" : "尚无成功图片记录"}。
    参考图{model.maxReferences === null ? "上限未知" : `最多 ${model.maxReferences} 张`}；蒙版{model.mask === null ? "待确认" : model.mask ? "支持" : "不支持"}。
    {model.source && <a href={model.source} target="_blank" rel="noreferrer" className="underline">接口说明</a>}
  </p>)}</div>;
}

export function ImageOptionSelect({ value, onChange, values, labels = {} }: { value: string; onChange: (value: string) => void; values: string[]; labels?: Record<string, string> }) {
  return <Select value={value} onValueChange={onChange}>{!values.includes(value) && <option value={value} disabled>{value} · 当前模型不支持</option>}{values.map(v => <option key={v} value={v}>{labels[v] || v}</option>)}</Select>;
}
