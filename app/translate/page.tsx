import { BatchDetailWorkspace } from "@/components/projects/batch-detail-workspace";
import { redirect } from "next/navigation";

export default function TranslatePage({ searchParams }: { searchParams: { batch?: string } }) {
  if (searchParams.batch) redirect(`/translate/${encodeURIComponent(searchParams.batch)}`);
  return <BatchDetailWorkspace key={searchParams.batch || "new"} translation />;
}
