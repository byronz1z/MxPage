import Link from "next/link";

export default function NotFound() {
  return <section className="mx-auto max-w-xl space-y-4 rounded-2xl border bg-card p-6">
    <h1 className="text-xl font-semibold">页面或作品已不存在</h1>
    <p className="text-sm text-muted-foreground">链接可能已失效，或作品已被删除。可以返回列表查看其他作品。</p>
    <Link href="/history" className="inline-block text-sm underline">返回我的作品</Link>
  </section>;
}
