import { HomeCreateWorkspace } from "@/components/projects/home-create-workspace";
import type { Metadata } from "next";
import { publicSiteUrl } from "@/lib/seo";
export const dynamic = "force-dynamic";

const site = publicSiteUrl();
export const metadata: Metadata = {
  alternates: site ? { canonical: site.href } : undefined,
  robots: { index: !!site, follow: !!site },
};

export default async function DashboardPage({ searchParams }: { searchParams: { batch?: string } }) {
  return (
    <div className="space-y-6" data-home-workspace>
      <HomeCreateWorkspace key={searchParams.batch || "new"} initialBatch={!!searchParams.batch} />
    </div>
  );
}
