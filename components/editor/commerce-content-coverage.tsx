import { commerceContentModuleLabels } from "@/lib/ai/prompts/ecommerce-system";
import { contentCoverageSchema, normalizeContentCoverage } from "@/lib/detail-runs/content-review-v4";

export function CommerceContentCoverage({ plan }: { plan: unknown }) {
  if (!plan || typeof plan !== "object" || !("contentCoverage" in plan)) return null;
  const parsed = contentCoverageSchema.safeParse(plan.contentCoverage);
  if (!parsed.success) return null;
  const sections = "sections" in plan && Array.isArray(plan.sections) ? plan.sections : [];
  const coverage = normalizeContentCoverage(sections, parsed.data);
  const placed = (item: (typeof coverage)[number]) => item.sectionIndexes.length > 0
    && item.sectionIndexes.every(index => typeof sections[index]?.copy === "string" && sections[index].copy.trim())
    && item.sectionIndexes.some(index => sections[index]?.kind === "DETAIL");
  const covered = coverage.filter(item => item.status === "covered" && placed(item)).length;
  const partial = coverage.filter(item => item.status === "partial" && placed(item)).length;
  return <details className="rounded-2xl border bg-card text-card-foreground p-5">
    <summary className="cursor-pointer font-medium">详情页内容清单 <span className="ml-2 text-sm font-normal text-muted-foreground">{covered}/{coverage.length} 类内容已完整安排{partial > 0 && ` · ${partial} 类部分已安排`}</span></summary>
    <p className="mt-3 text-sm text-muted-foreground">逐项说明内容放在哪张图，以及需要补充的资料。这里表示规划覆盖，实际图片仍需复核。</p>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead><tr className="border-b"><th className="py-2 pr-4">内容模块</th><th className="py-2 pr-4">规划状态</th><th className="py-2">页面与说明</th></tr></thead>
        <tbody>{coverage.map(item => <tr key={item.module} className="border-b last:border-0">
          <td className="py-3 pr-4 align-top">{commerceContentModuleLabels[item.module]}</td>
          <td className="whitespace-nowrap py-3 pr-4 align-top">{["covered", "partial"].includes(item.status) && !placed(item) ? "待安排到详情页" : { covered: "已安排", partial: "部分已安排，仍需补充", needs_input: "待补充资料", not_applicable: "本任务不适用" }[item.status]}</td>
          <td className="py-3 align-top">{item.sectionIndexes.length > 0 && <span className="mr-2">{item.sectionIndexes.map(index => `第 ${index + 1} 张`).join("、")}</span>}{item.reason}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </details>;
}
