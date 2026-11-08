import { cents } from "./format";

/** Spend vs. monthly cap, colored at Paperclip's 80% soft alert and 100% hard stop. */
export function BudgetBar({ spentCents, budgetCents, suffix }: { spentCents: number; budgetCents?: number | null; suffix?: string }) {
  if (!budgetCents) return null;
  const pct = Math.min(100, (spentCents / budgetCents) * 100);
  return (
    <div className="budget" title={`${cents(spentCents)} of ${cents(budgetCents)}`}>
      <div className="bar" style={{ width: `${pct}%` }} data-level={pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok"} />
      <span>
        {cents(spentCents)} / {cents(budgetCents)}
        {suffix ?? ""}
      </span>
    </div>
  );
}
