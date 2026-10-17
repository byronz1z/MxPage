// Editable estimation baseline, not a live market exchange rate.
export const DEFAULT_USD_TO_CNY = 7;

/** Source records stay in USD; apply the selected exchange rate only for display. */
export function formatCostCny(costUsd: number | null | undefined, usdToCny: number, fractionDigits?: 4 | 5 | 6): string {
  if (costUsd == null || !Number.isFinite(costUsd) || costUsd < 0 || !Number.isFinite(usdToCny) || usdToCny <= 0) return "—";
  const amount = costUsd * usdToCny;
  const digits = fractionDigits ?? (amount > 0 && amount < 0.01 ? 6 : 4);
  const minimum = 10 ** -digits;
  if (amount > 0 && amount < minimum) return `<¥${minimum.toFixed(digits)}`;
  return `¥${amount.toFixed(digits)}`;
}
