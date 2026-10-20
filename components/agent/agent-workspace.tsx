"use client";
import { AgentMoneyBudget } from "./agent-money-budget";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Dialog from "@radix-ui/react-dialog";
import { Bot, Plus, Send, Paperclip, Settings2, PanelLeft, PanelRight, X, FileText, Download, ExternalLink, Pause, Play, Square, Check, Loader2, Archive, Trash2, Pencil, Globe, ImageIcon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { agentFetch, agentStatus, toolLabels } from "@/lib/agent/client";
import { cn } from "@/lib/utils";
import { ArtifactPreview } from "./artifact-preview";

type Message = { id: string; role: string; content: string };
type Artifact = { id: string; name: string; kind: string; mimeType: string; url?: string; filePath?: string };
type Session = { id: string; title: string; modelId: string | null; archived: boolean; messages?: Message[]; runs?: any[]; artifacts?: Artifact[] };
const done = ["COMPLETED", "FAILED", "STOPPED"];
const markdownClass = "break-words text-sm leading-7 [&_a]:text-primary [&_a]:underline [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-secondary [&_pre]:p-3 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-semibold [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2";
function Drawer({ title, children, icon }: { title: string; children: React.ReactNode; icon: React.ReactNode }) {
  return <Dialog.Root><Dialog.Trigger asChild><Button size="sm" variant="outline" className="xl:hidden" aria-label={title}>{icon}</Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/35" /><Dialog.Content className="fixed bottom-0 right-0 top-0 z-50 w-[min(90vw,360px)] overflow-auto border-l bg-card p-5"><Dialog.Title className="mb-5 text-lg font-semibold">{title}</Dialog.Title><Dialog.Description className="sr-only">查看{title}并管理当前任务</Dialog.Description><Dialog.Close className="absolute right-4 top-5" aria-label="关闭"><X className="h-5 w-5" /></Dialog.Close>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function AgentWorkspace() {
  const [sessions, setSessions] = useState<Session[]>([]), [selected, setSelected] = useState<Session | null>(null);
  const [run, setRun] = useState<any>(null), [models, setModels] = useState<any[]>([]);
  const [input, setInput] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [archived, setArchived] = useState(false), [online, setOnline] = useState(true), [events, setEvents] = useState<any[]>([]), [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]), [rename, setRename] = useState(false), [title, setTitle] = useState(""), [deleteOpen, setDeleteOpen] = useState(false);
  const [retryIds, setRetryIds] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null), end = useRef<HTMLDivElement>(null), pending = useRef<{ key: string; content: string; files: string[] } | null>(null);
  const currentId = useRef<string | null>(null); currentId.current = selected?.id || null;
  const refreshList = useCallback(async () => setSessions(await agentFetch(`/api/agent/sessions?archived=${archived}`)), [archived]);
  const load = useCallback(async (id: string) => {
    const value = await agentFetch<Session>(`/api/agent/sessions/${id}`);
    if (currentId.current && currentId.current !== id) return;
    setSelected(value);
    const latest = value.runs?.[0];
    setRun(latest ? await agentFetch(`/api/agent/runs/${latest.id}`) : null);
  }, []);
  useEffect(() => { refreshList().catch(e => setError(e.message)); }, [refreshList]);
  useEffect(() => { agentFetch("/api/agent/settings").then(data => setModels(data.models)).catch(e => setError(e.message)); }, []);
  const select = async (session: Session) => { currentId.current = session.id; setSelected(session); setEvents([]); setDraft(""); setRun(null); setAttachments([]); setError(""); await load(session.id); };
  useEffect(() => {
    if (!run?.id) return;
    const stream = new EventSource(`/api/agent/runs/${run.id}/events`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSeq = 0;
    stream.onopen = () => setOnline(true); stream.onerror = () => setOnline(false);
    stream.onmessage = event => {
      const item = JSON.parse(event.data);
      if (item.seq <= lastSeq) return; lastSeq = item.seq;
      setEvents(old => old.some(i => i.seq === item.seq) ? old : [...old, item].slice(-100));
      if (item.type === "text_delta") setDraft(old => old + item.data.text);
      if (["message", "model_start"].includes(item.type)) setDraft("");
      clearTimeout(timer); timer = setTimeout(() => { if (currentId.current) void load(currentId.current); }, 200);
    };
    return () => { clearTimeout(timer); stream.close(); };
  }, [run?.id, load]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selected?.messages?.length, draft]);
  const safe = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } };
  const create = async () => { const session = await agentFetch<Session>("/api/agent/sessions", { method: "POST" }); await select(session); await refreshList(); return session; };
  const send = () => safe(async () => {
    if (!input.trim()) return;
    if (run?.status === "WAITING_INPUT") {
      await agentFetch(`/api/agent/runs/${run.id}`, { method: "POST", body: JSON.stringify({ action: "answer", answer: input }) }); setInput(""); await load(selected!.id); return;
    }
    const session = selected || await create();
    const attempt = pending.current?.content === input && JSON.stringify(pending.current.files) === JSON.stringify(attachments) ? pending.current : { key: crypto.randomUUID(), content: input, files: attachments };
    pending.current = attempt;
    await agentFetch(`/api/agent/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ content: attempt.content, fileIds: attempt.files, idempotencyKey: attempt.key }) });
    pending.current = null; setInput(""); setAttachments([]); setDraft(""); setEvents([]); await load(session.id); await refreshList();
  });
  const action = (action: string, extras = {}) => safe(async () => {
    if (["approve", "resume"].includes(action) && run.plan?.tools?.some((name: string) => ["computer", "browser"].includes(name) || run.snapshot.settings.mcp.some((s: any) => s.transport === "stdio" && name.startsWith(`mcp_${s.id}_`)))) {
      if (!window.mxPageDesktop?.agent) throw new Error("请在桌面版确认本机控制方案。");
      await window.mxPageDesktop.agent.grant(run.id, run.planHash);
    }
    await agentFetch(`/api/agent/runs/${run.id}`, { method: "POST", body: JSON.stringify({ action, planHash: run.planHash, ...extras }) }); await load(selected!.id);
  });
  const upload = (files: FileList | null) => safe(async () => {
    if (!files?.length) return; const session = selected || await create(); const ids: string[] = [];
    for (const file of Array.from(files)) { const form = new FormData(); form.set("file", file); ids.push((await agentFetch(`/api/agent/sessions/${session.id}/files`, { method: "POST", body: form })).id); }
    setAttachments(old => [...old, ...ids].slice(0, 20)); await load(session.id); if (fileInput.current) fileInput.current.value = "";
  });
  const sessionList = <div className="space-y-4"><Button onClick={() => safe(async () => { await create(); })} disabled={busy} className="w-full"><Plus className="mr-2 h-4 w-4" />新建会话</Button><button onClick={() => setArchived(!archived)} className="flex items-center gap-2 text-xs text-muted-foreground"><Archive className="h-3.5 w-3.5" />{archived ? "返回最近会话" : "查看已归档"}</button><div className="space-y-1">{sessions.length ? sessions.map(session => <button key={session.id} onClick={() => safe(() => select(session))} className={cn("w-full truncate rounded-xl px-3 py-3 text-left text-sm", selected?.id === session.id ? "bg-secondary font-medium" : "hover:bg-accent")}>{session.title}</button>) : <p className="py-6 text-sm text-muted-foreground">{archived ? "暂无归档会话" : "从一个问题或任务开始。"}</p>}</div></div>;
  const plan = run?.plan;
  const hasSavedAnswer = Boolean(run?.id && selected?.messages?.some(message => message.id === `${run.id}-answer`));
  const artifacts = selected?.artifacts || [];
  const observation = artifacts.filter(a => a.kind === "observation").at(-1);
  const rightPanel = <div className="space-y-6">
    <section><h2 className="mb-3 text-sm font-semibold">计划与进度</h2>{plan ? <div className="space-y-3 text-sm"><p className="font-medium">{plan.goal}</p><ol className="space-y-2">{plan.steps.map((step: string, i: number) => <li key={i} className="flex gap-2 text-muted-foreground"><span className="shrink-0 text-primary">{i + 1}.</span>{step}</li>)}</ol><div className="space-y-2 rounded-xl border bg-background p-3 text-xs leading-5"><p>生成数量：{plan.generationCount} 张</p><p>预计费用：{plan.estimatedCost || "未知，按模型服务实际用量计费"}</p><p>工具：{plan.tools.map((t: string) => toolLabels[t] || t).join("、") || "无"}</p>{plan.fileIds.length > 0 && <p>文件：{plan.fileIds.map((id: string) => artifacts.find(a => a.id === id)?.name || id).join("、")}</p>}{plan.applications.length > 0 && <p>应用：{plan.applications.join("、")}</p>}{plan.directories.length > 0 && <p className="break-all">目录：{plan.directories.join("、")}</p>}{plan.permissions.map((p: string) => <p key={p}>{p}</p>)}</div>{run.status === "WAITING_APPROVAL" && <Button className="w-full" disabled={busy} onClick={() => action("approve")}><Check className="mr-2 h-4 w-4" />确认方案并执行</Button>}</div> : <p className="text-xs leading-6 text-muted-foreground">执行任务前，这里会展示整批方案。确认一次后，Agent 自动完成已批准范围内的步骤。</p>}</section>
    {run && <section className="space-y-2 border-t pt-4"><p className="text-xs text-muted-foreground">模型 {run.modelCalls}/{run.modelLimit} · 工具 {run.toolCalls}/{run.toolLimit}</p>{run.calls?.slice(-8).map((call: any) => <div key={call.id} className="flex items-start gap-2 text-xs"><span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", call.status === "COMPLETED" ? "bg-emerald-500" : "bg-amber-500")} /><span className="min-w-0 flex-1 break-words">{toolLabels[call.name] || call.name}<span className="ml-2 text-muted-foreground">{({ COMPLETED: "完成", RUNNING: "执行中", UNCERTAIN: "结果未知", BLOCKED: "已暂停", RETRY: "待重试" } as any)[call.status]}</span></span></div>)}</section>}
    {run && <AgentMoneyBudget key={run.id} run={run} busy={busy} onContinue={extras => action("resume", extras)}/>}
    {observation && <section><h2 className="mb-2 flex gap-2 text-sm font-semibold"><Monitor className="h-4 w-4" />最近电脑画面</h2><img src={`/api/agent/artifacts/${observation.id}`} alt="最近一次观察到的目标应用" className="w-full rounded-xl border" /><p className="mt-2 text-xs text-muted-foreground">{plan?.applications.join("、")} · Ctrl/⌘ + Shift + Esc 停止</p></section>}
    <section><h2 className="mb-3 text-sm font-semibold">成果与文件 <span className="ml-1 font-normal text-muted-foreground">{artifacts.filter(a => a.kind !== "observation").length}</span></h2><div className="space-y-3">{artifacts.filter(a => a.kind !== "observation").map(a => <div key={a.id} className="overflow-hidden rounded-xl border bg-background">{a.mimeType.startsWith("image/") && <a href={`/api/agent/artifacts/${a.id}`} target="_blank" rel="noreferrer"><img src={`/api/agent/artifacts/${a.id}`} alt={a.name} className="max-h-40 w-full object-contain" /></a>}<div className="flex items-center gap-2 p-3"><FileText className="h-4 w-4 shrink-0 text-muted-foreground" />{a.filePath && a.kind !== "archive" ? <ArtifactPreview artifact={a} /> : <a href={a.url || `/api/agent/artifacts/${a.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-xs hover:underline">{a.name}</a>}{a.filePath ? <a href={`/api/agent/artifacts/${a.id}?download=1`} aria-label={`下载 ${a.name}`}><Download className="h-4 w-4" /></a> : <a href={a.url} aria-label={`打开 ${a.name}`}><ExternalLink className="h-4 w-4" /></a>}</div></div>)}{!artifacts.length && <p className="text-xs text-muted-foreground">上传的文件和生成的成果会保存在这里。</p>}</div></section>
  </div>;
  return <div className="flex min-h-[75vh] flex-col">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h1 className="flex items-center gap-2 text-xl font-semibold"><Bot className="h-5 w-5" />Agent 工作台</h1><p className="mt-1 text-xs text-muted-foreground">研究、创作与文件处理，从对话开始</p></div><div className="flex gap-2"><Drawer title="会话列表" icon={<PanelLeft className="h-4 w-4" />}>{sessionList}</Drawer><Drawer title="计划与成果" icon={<PanelRight className="h-4 w-4" />}>{rightPanel}</Drawer><Link href="/settings/agent" aria-label="Agent 设置" className="rounded-xl border p-2.5 hover:bg-accent"><Settings2 className="h-4 w-4" /></Link></div></header>
    <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[170px_minmax(0,1fr)_240px] 2xl:grid-cols-[190px_minmax(0,1fr)_260px]">
      <aside className="hidden border-r pr-4 xl:block">{sessionList}</aside>
      <section aria-label="对话" className="flex min-w-0 flex-col xl:px-5">
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-3"><span className="min-w-0 flex-1 truncate text-sm font-medium">{selected?.title || "新会话"}</span>{selected && <><button aria-label="重命名会话" onClick={() => { setTitle(selected.title); setRename(true); }}><Pencil className="h-3.5 w-3.5 text-muted-foreground" /></button><button aria-label={selected.archived ? "取消归档" : "归档会话"} onClick={() => safe(async () => { await agentFetch(`/api/agent/sessions/${selected.id}`, { method: "PATCH", body: JSON.stringify({ archived: !selected.archived }) }); await load(selected.id); await refreshList(); })}><Archive className="h-3.5 w-3.5 text-muted-foreground" /></button><button aria-label="删除会话" onClick={() => setDeleteOpen(true)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></button></>}<select aria-label="会话模型" className="w-full max-w-[240px] rounded-lg border bg-background px-2 py-1.5 text-xs" value={selected?.modelId || ""} onChange={e => safe(async () => { const session = selected || await create(); await agentFetch(`/api/agent/sessions/${session.id}`, { method: "PATCH", body: JSON.stringify({ modelId: e.target.value || null }) }); await load(session.id); })}><option value="">使用已保存的文本模型</option>{models.map(m => <option key={m.id} value={m.id}>{m.label}{m.vision ? " · 视觉" : ""}</option>)}</select></div>
        {!models.length && <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">尚未配置可用文本模型。<Link href="/settings/providers" className="ml-2 underline">前往 API 配置</Link></div>}
        <div className="min-h-[340px] flex-1 space-y-5 overflow-y-auto pb-5 xl:max-h-[56vh]" aria-live="polite">
          {!selected?.messages?.length && <div className="flex min-h-[330px] flex-col items-center justify-center py-8 text-center"><div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary"><Bot className="h-7 w-7" /></div><h2 className="text-xl font-medium">今天想完成什么？</h2><p className="mb-7 mt-2 max-w-sm text-sm leading-6 text-muted-foreground">告诉我目标，或上传素材。复杂任务会先给出方案，确认后再开始执行。</p><div className="grid w-full gap-2 text-left sm:grid-cols-2">{[[Globe, "搜索资料，整理成研究文档"], [FileText, "分析表格，提炼关键发现"], [ImageIcon, "用商品图制作电商内容"], [Monitor, "在桌面版操作指定软件"]].map(([Icon, text]: any) => <button key={text} onClick={() => setInput(text)} className="flex items-center gap-2 rounded-xl border p-3 text-left text-xs hover:bg-accent"><Icon className="h-4 w-4 shrink-0 text-muted-foreground" />{text}</button>)}</div></div>}
          {selected?.messages?.map(m => <article key={m.id} className={cn("rounded-2xl px-4 py-3", m.role === "user" ? "ml-6 bg-secondary" : "mr-2 border bg-background")}><p className="mb-1 text-[11px] font-medium text-muted-foreground">{m.role === "user" ? "你" : "Agent"}</p><div className={markdownClass}><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node, ...props }) => {
            // Old model replies sometimes used storage paths. Only map exact files from this session.
            const artifact = props.href && artifacts.find(a => a.filePath === props.href!.replace(/^\//, ""));
            return <a {...props} href={artifact ? `/api/agent/artifacts/${artifact.id}?download=1` : props.href} target="_blank" rel="noreferrer" />;
          } }}>{m.content}</Markdown></div></article>)}
          {draft && !hasSavedAnswer && <div className={markdownClass}><Markdown remarkPlugins={[remarkGfm]}>{draft}</Markdown></div>}
          {run && !done.includes(run.status) && <div className="rounded-xl border border-dashed p-4"><div className="flex items-center gap-2 text-sm">{run.status === "RUNNING" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}{agentStatus[run.status]}</div><p className="mt-2 text-xs leading-6 text-muted-foreground">{run.error || (run.status === "WAITING_APPROVAL" ? "请在计划面板检查工具、文件和生成数量，再确认执行。" : events.filter(e => e.type === "tool_start").at(-1)?.data.name ? `正在处理：${toolLabels[events.filter(e => e.type === "tool_start").at(-1)?.data.name] || events.filter(e => e.type === "tool_start").at(-1)?.data.name}` : "正在准备当前步骤。")}</p>
            <div className="mt-3 flex flex-wrap gap-2">{run.status === "RUNNING" && <Button size="sm" variant="outline" onClick={() => action("pause")}><Pause className="mr-1 h-3 w-3" />暂停</Button>}{["PAUSED", "INTERRUPTED"].includes(run.status) && <Button size="sm" onClick={() => action("resume", { extendBudget: run.modelCalls >= run.modelLimit || run.toolCalls >= run.toolLimit })}><Play className="mr-1 h-3 w-3" />{run.modelCalls >= run.modelLimit || run.toolCalls >= run.toolLimit ? "追加一轮预算并继续" : "继续"}</Button>}<Button size="sm" variant="outline" onClick={() => action("stop")}><Square className="mr-1 h-3 w-3" />停止</Button></div>
            {run.status === "UNCERTAIN" && <div className="mt-3 space-y-2 border-t pt-3 text-xs"><p>以下调用结果未知。重试可能重复计费或重复执行；电脑操作不能重放。</p>{run.calls?.filter((c: any) => ["RUNNING", "UNCERTAIN", "BLOCKED"].includes(c.status)).map((c: any) => <label key={c.id} className="flex gap-2"><input type="checkbox" disabled={["computer", "browser"].includes(c.name)} checked={retryIds.includes(c.id)} onChange={e => setRetryIds(old => e.target.checked ? [...old, c.id] : old.filter(id => id !== c.id))} />{toolLabels[c.name] || c.name}</label>)}<Button size="sm" variant="outline" disabled={!retryIds.length} onClick={() => action("resume", { retryCallIds: retryIds })}>明确重试所选调用</Button></div>}
          </div>}
          {run?.status === "FAILED" && <p className="rounded-xl border border-destructive/30 p-3 text-sm text-destructive">{run.error} 可以发送新消息重新开始。</p>}<div ref={end} />
        </div>
        <div className="mt-auto space-y-2 border-t pt-3">{!online && <p className="text-xs text-amber-600">连接中断，正在重新读取执行事件。不会重新发送任务。</p>}{error && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}{attachments.length > 0 && <div className="flex flex-wrap gap-2">{attachments.map(id => <button key={id} onClick={() => setAttachments(old => old.filter(i => i !== id))} className="flex items-center gap-1 rounded-lg bg-secondary p-2 text-xs">{artifacts.find(a => a.id === id)?.name || "附件"}<X className="h-3 w-3" /></button>)}</div>}<div className="rounded-2xl border bg-background p-3"><textarea aria-label="发送消息" value={input} onChange={e => setInput(e.target.value)} placeholder={run?.status === "WAITING_INPUT" ? "补充所需信息…" : "描述你的目标，或先上传文件…"} rows={3} className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground" onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!busy && (!run || done.includes(run.status) || run.status === "WAITING_INPUT")) void send(); } }} /><div className="flex items-center justify-between"><input ref={fileInput} type="file" multiple className="hidden" accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.pdf,.docx,.xlsx" onChange={e => upload(e.target.files)} /><Button aria-label="上传文件" variant="ghost" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip className="h-4 w-4" /><span className="ml-2 text-xs">文件 / 图片</span></Button><Button disabled={busy || !input.trim() || !models.length || Boolean(run && !done.includes(run.status) && run.status !== "WAITING_INPUT")} onClick={send} size="sm">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}<span className="ml-2">{run?.status === "WAITING_INPUT" ? "补充并继续" : "发送"}</span></Button></div></div><p className="text-center text-[10px] text-muted-foreground">Enter 发送 · Shift + Enter 换行 · 文件保存在当前会话</p></div>
      </section>
      <aside className="hidden max-h-[76vh] overflow-y-auto border-l pl-4 xl:block">{rightPanel}</aside>
    </div>
    <Dialog.Root open={rename} onOpenChange={setRename}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-6"><Dialog.Title className="font-semibold">重命名会话</Dialog.Title><Dialog.Description className="mt-2 text-sm text-muted-foreground">便于在会话列表中找到它。</Dialog.Description><input aria-label="会话名称" value={title} onChange={e => setTitle(e.target.value)} className="my-4 w-full rounded-xl border bg-background p-3" /><div className="flex justify-end gap-2"><Dialog.Close asChild><Button variant="outline">取消</Button></Dialog.Close><Button onClick={() => safe(async () => { await agentFetch(`/api/agent/sessions/${selected!.id}`, { method: "PATCH", body: JSON.stringify({ title }) }); setRename(false); await load(selected!.id); await refreshList(); })}>保存</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <Dialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(90vw,400px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-card p-6"><Dialog.Title className="font-semibold">删除此会话？</Dialog.Title><Dialog.Description className="my-4 text-sm text-muted-foreground">会话消息、执行记录和会话文件会一并删除。已经保存到“我的作品”的项目仍可查看。</Dialog.Description><div className="flex justify-end gap-2"><Dialog.Close asChild><Button variant="outline">取消</Button></Dialog.Close><Button variant="destructive" onClick={() => safe(async () => { await agentFetch(`/api/agent/sessions/${selected!.id}`, { method: "DELETE" }); setDeleteOpen(false); currentId.current = null; setSelected(null); setRun(null); await refreshList(); })}>删除</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}
