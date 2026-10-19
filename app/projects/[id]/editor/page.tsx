import { notFound, redirect } from "next/navigation";
import { isTranslationProject, translationEntryHref } from "@/lib/utils/project-entry";
import { DetailWorkspace } from "@/components/editor/detail-workspace";
import { TranslationProjectWorkspace } from "@/components/translation/translation-project-workspace";
import { getProjectDetail } from "@/lib/services/project-service";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: { id: string } }) {
  const project = await getProjectDetail(params.id);
  if (!project) notFound();
  if (isTranslationProject(project)) {
    const href = translationEntryHref(project);
    if (href.startsWith("/translate/")) redirect(href);
    return <TranslationProjectWorkspace initialProject={JSON.parse(JSON.stringify(project))}/>;
  }
  return <DetailWorkspace initialProject={JSON.parse(JSON.stringify(project))}/>;
}
