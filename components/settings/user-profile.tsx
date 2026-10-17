"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Pencil, RefreshCw, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { UserProfile } from "@/lib/profile";
import type { UsageActivity } from "@/lib/monitor/activity";
import { formatCostCny } from "@/lib/monitor/currency";
import { prepareAvatar, saveProfile, useProfile } from "./profile-store";

export function UserAvatar({ profile, className }: { profile: UserProfile; className?: string }) {
  return <span className={cn("inline-flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary text-muted-foreground", className)}>
    {profile.avatar ? <img src={profile.avatar} alt={`${profile.name}的头像`} className="h-full w-full object-cover" /> : <UserRound aria-hidden="true" className="h-1/2 w-1/2" />}
  </span>;
}

function ProfileEditor() {
  const { profile, loaded } = useProfile();
  const [draft, setDraft] = useState(profile);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog.Root open={open} onOpenChange={value => { if (busy) return; if (value) { setDraft(profile); setError(""); } setOpen(value); }}>
    <Dialog.Trigger asChild><Button variant="outline" disabled={!loaded} className="gap-2"><Pencil className="h-3.5 w-3.5" />编辑资料</Button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[110] bg-black/45 backdrop-blur-sm" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-[111] max-h-[90vh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-border bg-card p-6 shadow-xl">
        <Dialog.Title className="text-xl font-semibold">编辑个人资料</Dialog.Title>
        <Dialog.Description className="mt-2 text-sm text-muted-foreground">头像和名称用于当前浏览器的用户中心。</Dialog.Description>
        <form className="mt-6 space-y-5" onSubmit={event => {
          event.preventDefault(); setError("");
          try { saveProfile(draft); setOpen(false); toast.success("个人资料已保存"); }
          catch (cause) { setError((cause as { issues?: Array<{ message: string }> }).issues?.[0]?.message || "保存失败，请检查浏览器是否允许本地存储。"); }
        }}>
          <div className="flex items-center gap-4">
            <UserAvatar profile={draft} className="h-20 w-20" />
            <div className="space-y-2">
              <label className={cn("inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-accent focus-within:ring-2 focus-within:ring-ring", busy && "pointer-events-none opacity-50")}>
                <Camera aria-hidden="true" className="h-4 w-4" />{busy ? "处理图片中…" : "上传头像"}
                <input aria-label="上传头像" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" disabled={busy} onChange={async event => {
                  const file = event.target.files?.[0]; event.target.value = "";
                  if (!file) return;
                  setBusy(true); setError("");
                  try { const avatar = await prepareAvatar(file); setDraft(current => ({ ...current, avatar })); }
                  catch (cause) { setError(cause instanceof Error ? cause.message : "图片无法读取，请换一张图片"); }
                  finally { setBusy(false); }
                }} />
              </label>
              {draft.avatar && <button type="button" disabled={busy} onClick={() => setDraft(current => ({ ...current, avatar: null }))} className="ml-3 text-xs text-muted-foreground underline">移除头像</button>}
              <p className="text-xs text-muted-foreground">最大 5 MB，居中裁切为圆形头像。</p>
            </div>
          </div>
          <label className="block space-y-2 text-sm">显示名称<Input aria-label="显示名称" value={draft.name} maxLength={40} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label className="block space-y-2 text-sm">用户名<Input aria-label="用户名" value={draft.username} maxLength={30} autoCapitalize="none" onChange={event => setDraft({ ...draft, username: event.target.value })} /><span className="block text-xs text-muted-foreground">2–30 位字母、数字、点、下划线或短横线。</span></label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2"><Dialog.Close asChild><Button type="button" variant="outline" disabled={busy}>取消</Button></Dialog.Close><Button disabled={busy} type="submit">保存资料</Button></div>
        </form>
        <Dialog.Close aria-label="关闭资料编辑" disabled={busy} className="absolute right-5 top-5 rounded-lg p-1 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

const number = (value: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const heatColors = {
  tokens: ["bg-blue-100 dark:bg-blue-950", "bg-blue-300 dark:bg-blue-900", "bg-blue-500", "bg-blue-700 dark:bg-blue-300"],
  costUsd: ["bg-teal-100 dark:bg-teal-950", "bg-teal-300 dark:bg-teal-900", "bg-teal-500", "bg-teal-700 dark:bg-teal-300"],
  requests: ["bg-violet-100 dark:bg-violet-950", "bg-violet-300 dark:bg-violet-900", "bg-violet-500", "bg-violet-700 dark:bg-violet-300"],
};

export function UserProfilePage({ activity, usdToCny }: { activity: UsageActivity; usdToCny: number }) {
  const cost = (value: number) => formatCostCny(value, usdToCny);
  const { profile } = useProfile();
  const router = useRouter();
  const [pending, transition] = useTransition();
  const [metric, setMetric] = useState<keyof typeof heatColors>("tokens");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedDay = activity.days.find(day => day.date === (selected ?? activity.today));
  const peak = Math.max(1e-12, ...activity.days.map(day => day[metric]));
  const columns = Math.ceil((activity.startWeekday + activity.days.length) / 7);
  const title = (day: UsageActivity["days"][number]) => `${day.date}：${day.requests} 次调用 · ${day.tokenSamples ? `${day.tokens.toLocaleString()} tokens` : "Token 未记录"} · ${day.priced ? cost(day.costUsd) : "费用未计价"}`;
  return <div className="space-y-8">
    <div className="flex items-center justify-between gap-3"><div><p className="text-xs text-muted-foreground">个人资料</p><h1 className="mt-1 text-2xl font-semibold">用户中心</h1></div><Button variant="ghost" size="sm" disabled={pending} onClick={() => transition(() => router.refresh())} className="gap-2 text-xs text-muted-foreground"><RefreshCw aria-hidden="true" className={cn("h-3.5 w-3.5", pending && "animate-spin")} />刷新记录</Button></div>
    <div className="flex flex-col items-center py-3 text-center">
      <UserAvatar profile={profile} className="h-24 w-24" />
      <h2 className="mt-4 max-w-full break-words text-2xl font-semibold">{profile.name}</h2>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">@{profile.username}</p>
      <ProfileEditor />
    </div>
    <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border lg:grid-cols-4">
      {[
        ["累计 Token", activity.totals.tokenSamples ? number(activity.totals.tokens) : "—"],
        ["已记录费用（人民币）", activity.totals.priced ? cost(activity.totals.costUsd) : "—"],
        ["累计调用", activity.totals.requests.toLocaleString()],
        ["活跃天数", `${activity.totals.activeDays} 天`],
      ].map(([label, value], index) => <div key={label} className={cn("border-border px-3 py-5 text-center lg:border-r lg:last:border-r-0", index < 2 && "border-b lg:border-b-0", index % 2 === 0 && "border-r")}><p className="break-all text-xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-xs text-muted-foreground">最近 12 个月 · {label}</p></div>)}
    </div>
    <section aria-label="最近12个月消耗热力图" className="min-w-0 rounded-2xl border border-border p-4 sm:p-5" aria-busy={pending}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-base font-semibold">消耗记录</h2><p className="mt-1 text-xs text-muted-foreground">最近 12 个月 · {activity.startDate} 至 {activity.today}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="热力图指标" className="flex rounded-lg bg-muted p-1">
            {([["tokens", "Token"], ["costUsd", "费用"], ["requests", "调用"]] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={metric === key} onClick={() => setMetric(key)} className={cn("rounded-md px-3 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring", metric === key ? "bg-card font-medium shadow-sm" : "text-muted-foreground")}>{label}</button>)}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="min-w-[720px]">
          <div className="mb-2 ml-7 grid text-[10px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {activity.days.map((day, index) => day.date.endsWith("-01") ? <span key={day.date} className="whitespace-nowrap" style={{ gridColumn: Math.floor((activity.startWeekday + index) / 7) + 1, gridRow: 1 }}><span className="block h-4 font-medium">{index === 0 || day.date.endsWith("-01-01") ? day.date.slice(0, 4) : ""}</span>{Number(day.date.slice(5, 7))}月</span> : null)}
          </div>
          <div className="flex gap-2">
            <div className="grid w-5 shrink-0 grid-rows-[repeat(7,minmax(0,1fr))] text-[10px] text-muted-foreground"><span style={{ gridRow: 2 }}>一</span><span style={{ gridRow: 4 }}>三</span><span style={{ gridRow: 6 }}>五</span></div>
            <div className="grid flex-1 grid-flow-col grid-rows-[repeat(7,minmax(0,1fr))] gap-[3px]" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {Array.from({ length: activity.startWeekday }, (_, i) => <span key={`pad-${i}`} />)}
              {activity.days.map(day => {
                const unknown = day.requests > 0 && (metric === "tokens" ? !day.tokenSamples : metric === "costUsd" ? !day.priced : false);
                const value = day[metric];
                const level = value > 0 ? Math.min(3, Math.floor(Math.sqrt(value / peak) * 4)) : -1;
                return <button type="button" key={day.date} title={title(day)} aria-label={title(day)}
                  onMouseEnter={() => setSelected(day.date)} onFocus={() => setSelected(day.date)} onClick={() => setSelected(day.date)}
                  className={cn("aspect-square min-w-0 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1", level < 0 ? "bg-muted" : heatColors[metric][level])}
                  style={unknown ? { backgroundImage: "repeating-linear-gradient(135deg, transparent, transparent 2px, hsl(var(--muted-foreground) / .35) 2px, hsl(var(--muted-foreground) / .35) 4px)" } : undefined} />;
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p className="min-h-4" aria-live="polite">{selectedDay ? title(selectedDay) : "悬停或点击日期，查看当天消耗"}</p>
        <div className="flex items-center gap-1.5"><span>少</span><i className="h-3 w-3 rounded-sm bg-muted" />{heatColors[metric].map(color => <i key={color} className={cn("h-3 w-3 rounded-sm", color)} />)}<span>多</span></div>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <span>最长连续活跃 <strong className="text-foreground">{activity.longestStreak} 天</strong></span>
        <span>当前连续活跃 <strong className="text-foreground">{activity.currentStreak} 天</strong></span>
        <span>单日 Token 峰值 <strong className="text-foreground">{number(activity.peakTokens)}</strong></span>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">统计当前工作空间记录，按北京时间划分日期。费用以人民币展示，按 1 USD = {usdToCny} CNY 估算折合，可在 API 监控的计费规则中调整；Token 仅统计接口已返回的用量。斜纹表示有调用但该项用量未知，未计价不代表免费。</p>
    </section>
    <p className="text-xs text-muted-foreground">个人资料仅保存在当前浏览器；清除浏览器数据后需重新配置。使用统计以 API 监控保留的记录为准。</p>
  </div>;
}
