import { ExternalLink, Github } from "lucide-react";
import packageInfo from "@/package.json";

const { version } = packageInfo;

export default function AboutPage() {
  return <div className="space-y-6"><div><p className="text-xs text-muted-foreground">应用信息</p><h1 className="mt-1 text-2xl font-semibold">关于 MxPage</h1></div>
    <section className="rounded-3xl border border-border p-6 sm:p-8">
      <div className="flex items-center gap-4"><img src="/brand-icon.ico" alt="MxPage" className="h-16 w-16 rounded-2xl" /><div><h2 className="text-2xl font-semibold">MxPage</h2><p className="mt-1 text-sm text-muted-foreground">AI 商品图文工作台 · v{version}</p></div></div>
      <p className="mt-6 text-sm leading-7 text-muted-foreground">把商品图变成详情页、小红书图文和可编辑商业视觉。支持商品分析、页面规划、图像生成、局部编辑、批量翻译与导出，以及 OpenAI 兼容模型接入。</p>
    </section>
    <section className="space-y-4 rounded-2xl border border-border p-6"><h2 className="font-semibold">品牌与版权信息</h2><p className="text-sm">灵矩绘境 · MxPage</p><p className="text-sm leading-6 text-muted-foreground">MxPage 由灵矩绘境出品。项目源码、许可及使用说明以官方仓库中的文件为准。</p><a href="https://github.com/ziguishian/mxpage" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm hover:bg-accent"><Github className="h-4 w-4" />项目 GitHub<ExternalLink className="h-3.5 w-3.5" /></a></section>
  </div>;
}
