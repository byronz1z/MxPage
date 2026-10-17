"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { ChartNoAxesCombined, ChevronRight, ChevronsUpDown, Info, Palette, Settings2, UserRound } from "lucide-react";
import { useProfile } from "@/components/settings/profile-store";
import { UserAvatar } from "@/components/settings/user-profile";
import { cn } from "@/lib/utils";

const links = [
  { href: "/settings/profile", title: "用户中心", icon: UserRound },
  { href: "/settings/providers", title: "API 配置", icon: Settings2 },
  { href: "/monitor/usage", title: "API 监控", icon: ChartNoAxesCombined },
  { href: "/settings/appearance", title: "外观设置", icon: Palette },
  { href: "/settings/about", title: "关于 MxPage", icon: Info },
];

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const { profile } = useProfile();
  return <Dialog.Root>
    <Dialog.Trigger asChild>
      <button type="button" aria-label="打开用户菜单" className={cn("flex items-center gap-3 rounded-2xl border border-border bg-background text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? "p-1.5" : "w-full p-3")}>
        <UserAvatar profile={profile} />
        {!compact && <><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{profile.name}</span><span className="block truncate text-xs text-muted-foreground">用户中心 · @{profile.username}</span></span><ChevronsUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /></>}
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/20" />
      <Dialog.Content className="fixed bottom-6 left-4 z-[101] w-[min(320px,calc(100vw_-_2rem))] rounded-3xl border border-border bg-card p-3 shadow-2xl md:bottom-[6.75rem] md:left-[max(2.25rem,calc((100vw_-_1600px)/2_+_2.25rem))]">
        <Dialog.Title className="sr-only">用户菜单</Dialog.Title><Dialog.Description className="sr-only">个人资料、模型配置、API 监控与应用设置。</Dialog.Description>
        <Dialog.Close asChild><Link href="/settings/profile" className="mb-2 flex items-center gap-3 rounded-2xl p-3 hover:bg-accent"><UserAvatar profile={profile} /><span className="min-w-0 flex-1"><span className="block truncate font-semibold">{profile.name}</span><span className="block truncate text-xs text-muted-foreground">@{profile.username}</span></span><ChevronRight className="h-4 w-4 text-muted-foreground" /></Link></Dialog.Close>
        <nav aria-label="用户设置" className="border-t border-border pt-2">
          {links.map(({ href, title, icon: Icon }) => <Dialog.Close asChild key={href}><Link href={href} className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />{title}</Link></Dialog.Close>)}
        </nav>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
