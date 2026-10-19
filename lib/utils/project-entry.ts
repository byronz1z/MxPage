type ProjectEntry = { id: string; modelSnapshot?: unknown; tasks?: Array<{ taskType: string }>; detailRuns?: Array<{ input: unknown }> };
export function isTranslationProject(project: ProjectEntry) {
  const snapshot = project.modelSnapshot as { workType?: string; translationReady?: boolean } | null;
  return project.id.startsWith("translation-") || snapshot?.workType === "translation" || !!snapshot?.translationReady
    || !!project.tasks?.some(task => task.taskType === "TRANSLATE_PAGE")
    || !!project.detailRuns?.some(run => (run.input as { mode?: string })?.mode === "translate");
}
export function translationEntryHref(project: ProjectEntry) {
  const snapshot = project.modelSnapshot as { translationReady?: boolean; translationBatchId?: string } | null;
  return !snapshot?.translationReady && snapshot?.translationBatchId
    ? `/translate/${encodeURIComponent(snapshot.translationBatchId)}` : `/projects/${project.id}/editor`;
}
export function workEntryHref(project: { id: string; category: string; sectionCount: number }) {
  return project.category === "xiaohongshu" ? `/xiaohongshu?project=${project.id}`
    : `/projects/${project.id}/${project.category === "translation" || project.sectionCount ? "editor" : "configure"}`;
}
