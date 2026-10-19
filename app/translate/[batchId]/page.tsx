import { TranslationBatchWorkspace } from "@/components/translation/translation-batch-workspace";

export default function TranslationBatchPage({ params }: { params: { batchId: string } }) {
  return <TranslationBatchWorkspace batchId={params.batchId} />;
}
