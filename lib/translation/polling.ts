import { TRANSLATION_WORKFLOW } from "./contracts";

export function translationNeedsPolling(project: {
  sections: Array<{ imageUrl?: string | null; status?: string }>;
  tasks: Array<{ status: string; inputPayload: unknown }>;
}) {
  if (project.tasks.some(task => ["PENDING", "RUNNING"].includes(task.status))) return true;
  if (project.sections.some(section => ["QUEUED", "GENERATING"].includes(section.status || ""))) return true;
  const task = project.tasks.find(task => (task.inputPayload as { workflow?: string } | null)?.workflow === TRANSLATION_WORKFLOW);
  // Prepared language versions may be waiting for their batch worker to create a task.
  return !task && project.sections.some(section => !section.imageUrl);
}
