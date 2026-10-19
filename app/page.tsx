import { HomeCreateWorkspace } from "@/components/projects/home-create-workspace";
export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams: { batch?: string } }) {
  return (
    <div className="space-y-6" data-home-workspace>
      <HomeCreateWorkspace key={searchParams.batch || "new"} initialBatch={!!searchParams.batch} />
    </div>
  );
}
