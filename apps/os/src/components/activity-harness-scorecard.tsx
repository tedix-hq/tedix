import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import { WorkReadFailure } from "./work-surface-primitives";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./kumo/table";
import { Text } from "./kumo/text";
import { Button } from "./kumo/button";

const compact = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 2,
});
const value = (n: number | null) => (n === null ? "—" : compact.format(n));
const time = (ms: number | null) =>
	ms === null ? "—" : `${compact.format(ms / 60_000)}m`;
const names: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
	tedi: "Tedi",
};

export function ActivityHarnessScorecard({
	scopes,
}: {
	scopes: (string | undefined)[];
	now: number;
}) {
	const [days, setDays] = useState<7 | 30>(7);
	const query = useQuery({
		...osQuery.workItems.getAgentScorecard.queryOptions({
			input: scopes.includes(undefined)
				? {}
				: {
						projectIds: [
							...new Set(
								scopes.filter((scope): scope is string => scope !== undefined),
							),
						],
					},
		}),
		...workRefreshOptions,
		refetchInterval: 30_000,
	});
	const history = query.data?.history;
	const failed =
		query.isError || query.failureCount > 0 || (!query.isPending && !history);
	const window = history?.windows.find((window) => window.days === days);
	return (
		<section aria-label="Agent scorecard" className="grid min-w-0 gap-2">
			<div className="flex gap-2" role="group" aria-label="Scorecard period">
				{([7, 30] as const).map((period) => (
					<Button
						key={period}
						size="sm"
						variant={days === period ? "secondary" : "ghost"}
						aria-pressed={days === period}
						onClick={() => setDays(period)}
					>
						{period} days
					</Button>
				))}
			</div>
			{failed && (
				<WorkReadFailure
					title="Agent scorecard unavailable"
					error={
						query.error ??
						query.failureReason ??
						new Error("Scorecard history unavailable")
					}
					onRetry={() => query.refetch()}
					retrying={query.isFetching}
				/>
			)}
			{query.isPending || failed ? (
				<Text tone="secondary">Counting agents…</Text>
			) : window?.rows.length ? (
				<Table
					scrollLabel={`Agent scorecard for the last ${days} days`}
					mobileLayout="stacked"
					className="w-full table-fixed [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal"
				>
					<TableHeader>
						<TableRow>
							{[
								"Agent / model",
								"Outcomes",
								"Settlement",
								"Cost / quality",
							].map((label) => (
								<TableHead key={label} scope="col">
									{label}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{window.rows.map((row) => (
							<TableRow key={JSON.stringify([row.executor, row.model])}>
								<TableCell label="Agent / model">
									<div>
										{names[row.executor] ?? row.executor}
										<br />
										<Text tone="secondary">{row.model ?? "Model unknown"}</Text>
									</div>
								</TableCell>
								<TableCell label="Outcomes">
									<div>
										<div>
											{row.attempts} attempts · {row.items} items
										</div>
										<div>
											Succeeded {row.succeeded} · Unverified{" "}
											{row.landedUnverified}
										</div>
										<div>
											Failed {row.failed} · Cancelled {row.cancelled}
										</div>
										<div>
											Expired {row.expired} · Rejected {row.rejected} ·
											Unsettled {row.unsettled}
										</div>
										<div>
											Success{" "}
											{row.successRate === null
												? "—"
												: `${Math.round(row.successRate * 100)}%`}
										</div>
									</div>
								</TableCell>
								<TableCell label="Settlement">
									<div>
										<div>Median {time(row.medianSettleMs)}</div>
										<div>p90 {time(row.p90SettleMs)}</div>
										<div>{value(row.attemptsPerItem)} attempts/item</div>
										<div>{row.landedItems} landed items</div>
									</div>
								</TableCell>
								<TableCell label="Cost / quality">
									<div>
										<div>USD/landed {value(row.costPerLandedItemUsd)}</div>
										<div>Tokens/landed {value(row.tokensPerLandedItem)}</div>
										<div>
											Reverts {value(row.reverts)} · Red CI {value(row.redCi)}
										</div>
										<div>
											CI observed {row.qualityObservedCommits}/
											{row.landedCommits} commits
										</div>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<Text tone="secondary">
					No agent started work in the last {days} days.
				</Text>
			)}
			<Text tone="secondary">
				Attempts started in this period, grouped by tool and model. Success is
				succeeded divided by all settled attempts; unverified results stay
				separate. Median and p90 measure time per settled attempt. Cost and
				tokens include all attempts, divided by newly landed items. — means
				unknown. Reverts and red CI count exact commits linked by Work trailers;
				CI coverage is shown and quality can change after landing.
			</Text>
			{history && (
				<Text tone="secondary">
					Observed {new Date(history.observedAt).toLocaleString()}
				</Text>
			)}
		</section>
	);
}
