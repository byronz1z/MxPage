"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section role="alert" className="mx-auto max-w-xl space-y-4 rounded-2xl border bg-card p-6">
    <h1 className="text-xl font-semibold">页面暂时无法加载</h1>
    <p className="text-sm leading-6 text-muted-foreground">已保存的作品和任务不会被清除。可以重新加载页面，或返回作品列表查看进度。</p>
    <div className="flex items-center gap-4"><Button onClick={reset}>重新加载页面</Button><Link href="/history" className="text-sm underline">我的作品</Link></div>
  </section>;
}
