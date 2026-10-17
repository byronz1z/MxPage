import { RecentProjectList } from "@/components/projects/recent-project-list";
import { PageHeader } from "@/components/shared/page-header";
import { redirect } from "next/navigation";
import Link from "next/link";
import { listProjectHistory } from "@/lib/services/project-history-service";
import { historyHref, parseHistoryQuery } from "@/lib/utils/project-history";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ searchParams }: { searchParams: { category?: string | string[]; page?: string | string[] } }) {
  const history = await listProjectHistory(searchParams);
  if (parseHistoryQuery(searchParams).page !== history.page) redirect(historyHref(history.category, history.page));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="创作画廊"
        title="我的作品"
        description="点击作品继续创作、修改或下载。"
      />

      <Link href="/tasks" className="inline-flex rounded-xl border px-4 py-2 text-sm hover:bg-accent">任务耗时记录</Link>
      <RecentProjectList history={history} />
    </div>
  );
}
