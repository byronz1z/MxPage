"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function AgentMoneySettings({ settings, onChange }: { settings: any; onChange: (settings: any) => void }) {
  return <section className="space-y-4 rounded-2xl border p-5"><h2 className="font-semibold">费用预算</h2><div className="grid gap-4 sm:grid-cols-2">
    <label className="space-y-2 text-sm">单任务预算（USD，留空不限）<input aria-label="单任务费用预算" type="number" min={0} max={10000} step="0.01" value={settings.moneyBudgetUsd ?? ""} onChange={e => onChange({ ...settings, moneyBudgetUsd: e.target.value === "" ? null : Number(e.target.value) })} className="w-full rounded-xl border bg-background p-2"/></label>
    <label className="space-y-2 text-sm">单次请求预留（USD）<input aria-label="单次请求预留" type="number" min="0.01" max={1000} step="0.01" value={settings.requestReserveUsd ?? 1} onChange={e => onChange({ ...settings, requestReserveUsd: Number(e.target.value) })} className="w-full rounded-xl border bg-background p-2"/></label>
  </div><label className="flex gap-2 text-sm"><input type="checkbox" checked={settings.pauseOnUnknownCost !== false} onChange={e => onChange({ ...settings, pauseOnUnknownCost: e.target.checked })}/>设置金额预算后，费用未知时暂停下一次调用</label>
    <p className="text-xs leading-6 text-muted-foreground">每次模型、搜索或 MCP 调用先预留金额，收到费用或用量后核算；无计费信息时保留预留额。请按服务商价格设置足够的单次预留。预留和估算不是服务商扣费上限，实际单次收费可能超过预留值。连接验证可能另计费。达到预算只停止新调用，已发出的请求继续收尾。</p>
  </section>;
}
export function AgentMoneyBudget({ run, busy, onContinue }: { run: any; busy: boolean; onContinue: (extras: Record<string, unknown>) => void }) {
  const [addition, setAddition] = useState(""), [acknowledged, setAcknowledged] = useState(false);
  const budget = run.budget;
  if (!budget) return null;
  const cap = run.snapshot?.settings?.moneyBudgetUsd;
  const money = (value: number) => `$${value.toFixed(4)}`;
  const canResume = ["PAUSED", "INTERRUPTED"].includes(run.status);
  return <section className="space-y-2 border-t pt-4 text-xs"><h2 className="font-semibold">费用记录（USD）</h2>
    <p>接口金额 {money(budget.actual)} · 用量估算 {money(budget.estimated)}</p>
    <p>在途预留 {money(budget.reserved)} · 费用未知 {budget.unknown} 次，保留 {money(budget.unknownReserve)}</p>
    <p>预算占用 {money(budget.total)} / {cap == null ? "未设置上限" : money(cap)}</p>
    {canResume && cap != null && <div className="space-y-2"><label className="block">追加金额（USD，可留空）<input aria-label="追加费用预算" type="number" min="0.01" max={10000} step="0.01" value={addition} onChange={e => setAddition(e.target.value)} className="mt-1 w-full rounded-lg border bg-background p-2"/></label>
      {budget.unacknowledged && <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/>已核对未知费用，同意保留其预留金额并继续</label>}
      <Button size="sm" variant="outline" disabled={busy || budget.unacknowledged && !acknowledged || Boolean(addition) && !(Number(addition) > 0)} onClick={() => onContinue({ ...(addition ? { additionalBudgetUsd: Number(addition) } : {}), acknowledgeUnknownCosts: acknowledged })}>确认费用预算并继续</Button>
    </div>}
  </section>;
}
