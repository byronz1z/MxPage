export const historyCategories = ["all", "detail", "xiaohongshu", "translation"] as const;
export type HistoryCategory = (typeof historyCategories)[number];
export type WorkCategory = Exclude<HistoryCategory, "all">;
export const historyCategoryLabels: Record<HistoryCategory, string> = {
  all: "全部", detail: "详情页", xiaohongshu: "小红书", translation: "翻译",
};
export const HISTORY_PAGE_SIZE = 12;

export function parseHistoryQuery(query: { category?: string | string[]; page?: string | string[] } = {}) {
  const category = historyCategories.includes(query.category as HistoryCategory) ? query.category as HistoryCategory : "all";
  const value = typeof query.page === "string" && /^\d+$/.test(query.page) ? Number(query.page) : 1;
  return { category, page: Number.isSafeInteger(value) && value > 0 ? value : 1 };
}

export function historyHref(category: HistoryCategory, page = 1) {
  const params = new URLSearchParams();
  if (category !== "all") params.set("category", category);
  if (page > 1) params.set("page", String(page));
  return `/history${params.size ? `?${params}` : ""}`;
}

export function historyPageNumbers(page: number, totalPages: number): Array<number | "ellipsis"> {
  const pages = new Set([1, totalPages]);
  for (let i = Math.max(1, page - 1); i <= Math.min(totalPages, page + 1); i++) pages.add(i);
  const result: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const value of [...pages].sort((a, b) => a - b)) {
    if (value - previous === 2) result.push(previous + 1);
    else if (value - previous > 2) result.push("ellipsis");
    result.push(value);
    previous = value;
  }
  return result;
}
