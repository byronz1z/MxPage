import type { ImageProgress } from "@/lib/detail-runs/contracts";

export function imageDisplayProgress(progress: ImageProgress[], runActive: boolean, tasks: Array<{ sectionId?: string | null; status: string; updatedAt: string | Date; taskType: string }> = [], localSectionId?: string, now = Date.now()): ImageProgress[] {
  const display = progress.map(image => image.state === "generating" && !runActive ? { ...image, state: "uncertain" as const } : { ...image });
  const generating = new Set(tasks.filter(task => task.status === "RUNNING" && ["GENERATE", "REGENERATE"].includes(task.taskType) && now - new Date(task.updatedAt).getTime() < 30 * 60_000).map(task => task.sectionId).filter(Boolean));
  if (localSectionId) generating.add(localSectionId);
  for (const sectionId of generating) {
    const current = display.find(image => image.sectionId === sectionId);
    if (current) current.state = "generating";
    else display.push({ sectionId: sectionId!, title: "", state: "generating", correctionCount: 0 });
  }
  return display;
}
