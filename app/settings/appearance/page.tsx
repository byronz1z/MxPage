import { ThemeToggle } from "@/components/layout/theme-toggle";

export default function AppearancePage() {
  return <div className="space-y-6"><div><p className="text-xs text-muted-foreground">应用设置</p><h1 className="mt-1 text-2xl font-semibold">外观</h1><p className="mt-2 text-sm text-muted-foreground">选择适合你的界面风格，偏好会保存在当前浏览器。</p></div><section className="max-w-xl space-y-4 rounded-2xl border border-border p-5"><h2 className="font-medium">显示模式</h2><ThemeToggle /></section></div>;
}
