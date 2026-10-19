"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChartNoAxesCombined, Info, Palette, Settings2, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";

export function SettingsNav({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();
  return <nav aria-label={mobile ? "移动端设置导航" : "设置导航"} className={mobile ? "flex flex-wrap gap-2" : "space-y-2"}>
    <Link href="/" className={cn("flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground", mobile ? "mb-1 w-full px-3 py-2" : "mb-4 border-b border-border px-4 pb-5 pt-2")}><ArrowLeft aria-hidden="true" className="h-4 w-4" />返回工作台</Link>
    {[
      { href: "/settings/profile", label: "个人资料", icon: UserRound },
      { href: "/settings/providers", label: "API 配置", icon: Settings2 },
      { href: "/settings/agent", label: "Agent 设置", icon: Settings2 },
      { href: "/settings/data", label: "数据管理", icon: Settings2 },
      { href: "/monitor/usage", label: "API 监控", icon: ChartNoAxesCombined },
      { href: "/settings/appearance", label: "外观", icon: Palette },
      { href: "/settings/about", label: "关于", icon: Info },
    ].map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} className={cn("flex shrink-0 items-center whitespace-nowrap text-sm transition-colors", mobile ? "gap-2 rounded-xl px-3 py-2" : "gap-3 rounded-2xl px-4 py-3", pathname === href ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}><Icon aria-hidden="true" className="h-4 w-4" />{label}</Link>)}
  </nav>;
}
