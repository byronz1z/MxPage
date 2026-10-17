import { notFound } from "next/navigation";
import { DetailWorkspace } from "@/components/editor/detail-workspace";
import { TranslationProjectWorkspace } from "@/components/translation/translation-project-workspace";
import { getProjectDetail } from "@/lib/services/project-service";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: { id: string } }) {
  const project = await getProjectDetail(params.id);
  if (!project) notFound();
  const snapshot = project.modelSnapshot as { translationReady?: boolean; workType?: string } | null;
  if (snapshot?.translationReady || snapshot?.workType === "translation") return <TranslationProjectWorkspace initialProject={JSON.parse(JSON.stringify(project))}/>;
  return <DetailWorkspace initialProject={JSON.parse(JSON.stringify(project))}/>;
}
