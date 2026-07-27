// Read-only tables for the Usage & Scoreboard dialog — the app's equivalent of
// the TUI's /usage and /scoreboard printouts (same columns, same ordering).
import { cn } from "~/lib/cn"
import {
  compactTokens,
  modelLabel,
  money,
  percent,
  rating,
  sortScoreboard,
  usageTotalsLine,
  type ScoreboardResponse,
  type UsageResponse,
} from "~/lib/stats"

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-border/70 border-b bg-muted/40 text-[10.5px] text-muted-foreground uppercase tracking-wide">
            {head.map((h, i) => (
              <th key={h} className={cn("px-2.5 py-1.5 font-medium", i === 0 ? "text-left" : "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Cell({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }) {
  return (
    <td className={cn("px-2.5 py-1.5", right ? "text-right tabular-nums" : "text-left", mono && "font-mono")}>
      {children}
    </td>
  )
}

export function EmptyStats({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-border border-dashed px-3 py-6 text-center text-[12px] text-muted-foreground">{children}</p>
}

export function ScoreboardTable({ body }: { body: ScoreboardResponse }) {
  const rows = sortScoreboard(body.rows)
  if (rows.length === 0) {
    return <EmptyStats>No rated work yet — rate a delegated turn and models start showing up here.</EmptyStats>
  }
  return (
    <Table head={["Model", "Kind", "N", "Avg", "Rework", "Cost", "Rating/$"]}>
      {rows.map((r) => (
        <tr key={`${modelLabel(r)}-${r.kind}`} className="border-border/50 border-b last:border-0">
          <Cell mono>{modelLabel(r)}</Cell>
          <Cell right>{r.kind}</Cell>
          <Cell right>{r.samples}</Cell>
          <Cell right>{rating(r.avgRating)}</Cell>
          <Cell right>{percent(r.reworkRate)}</Cell>
          <Cell right>{money(r.totalCost)}</Cell>
          <Cell right>{r.ratingPerDollar == null ? "—" : r.ratingPerDollar.toFixed(2)}</Cell>
        </tr>
      ))}
    </Table>
  )
}

export function UsageTable({ body }: { body: UsageResponse }) {
  if (body.roles.length === 0) return <EmptyStats>Nothing spent in this session yet.</EmptyStats>
  return (
    <div className="flex flex-col gap-2">
      <Table head={["Role", "Model", "In", "Out", "Cache R", "Cost", "Req"]}>
        {body.roles.map((r) => (
          <tr key={`${r.role}-${modelLabel(r)}`} className="border-border/50 border-b last:border-0">
            <Cell>{r.role}</Cell>
            <Cell right mono>{modelLabel(r)}</Cell>
            <Cell right>{compactTokens(r.inputTokens)}</Cell>
            <Cell right>{compactTokens(r.outputTokens)}</Cell>
            <Cell right>{compactTokens(r.cacheReadTokens)}</Cell>
            <Cell right>{money(r.cost)}</Cell>
            <Cell right>{r.requests}</Cell>
          </tr>
        ))}
      </Table>
      <p className="text-right text-[11.5px] text-muted-foreground">{usageTotalsLine(body.totals)}</p>
    </div>
  )
}
