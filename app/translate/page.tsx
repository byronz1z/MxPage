import { BatchDetailWorkspace } from "@/components/projects/batch-detail-workspace";

export default function TranslatePage({ searchParams }: { searchParams: { batch?: string } }) {
  return <BatchDetailWorkspace key={searchParams.batch || "new"} translation />;
}
