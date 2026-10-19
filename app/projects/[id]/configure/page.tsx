import { notFound, redirect } from "next/navigation";
import { getProjectDetail } from "@/lib/services/project-service";
import { ConfigureProject } from "@/components/projects/configure-project";
import { isTranslationProject, translationEntryHref } from "@/lib/utils/project-entry";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: { id: string } }) {
  const project = await getProjectDetail(params.id);
  if (!project) notFound();
  if (isTranslationProject(project)) redirect(translationEntryHref(project));
  if (project.sections.some(section => section.currentImageAssetId)) redirect(`/projects/${params.id}/editor`);
  return <ConfigureProject project={JSON.parse(JSON.stringify(project))}/>;
}
