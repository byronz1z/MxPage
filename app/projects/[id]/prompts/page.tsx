import { notFound, redirect } from "next/navigation";
import { DetailWorkspace } from "@/components/editor/detail-workspace";
import { getProjectDetail } from "@/lib/services/project-service";
import { isTranslationProject, translationEntryHref } from "@/lib/utils/project-entry";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { id: string } }) {
  const project = await getProjectDetail(params.id);
  if (!project) notFound();
  if (isTranslationProject(project)) redirect(translationEntryHref(project));
  return <DetailWorkspace initialProject={JSON.parse(JSON.stringify(project))} pageMode="prompts"/>;
}
