import { useQuery } from "@tanstack/react-query";
import type { AgentScorecardConfig } from "@tedix/api-contract/schemas/os-session-apps";
import { osQuery } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import { WorkReadFailure } from "@/components/work-surface-primitives";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import {
	PageHeader,
	PageHeading,
	PageTitle,
	PageDescription,
} from "@/components/kumo/page";
import { ListSkeleton } from "@/components/list-skeleton";

const compact = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 2,
});
const percent = (rate: number | null) =>
	rate === null ? "—" : `${Math.round(rate * 100)}%`;
const minutes = (ms: number | null) =>
	ms === null ? "—" : `${compact.format(ms / 60_000)}m`;
const cost = (usd: number | null) =>
	usd === null ? "—" : `$${compact.format(usd)}`;
const names: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	cursor: "Cursor",
	opencode: "OpenCode",
	devin: "Devin",
	tedi: "Tedi",
};

function kindLabel(row: {
	size: string | null;
	risk: string | null;
	tags: string[];
}): string {
	const parts = [
		row.size ? `${row.size} tasks` : "Any size",
		row.risk ? `${row.risk} risk` : "Any risk",
	];
	if (row.tags.length) parts.push(row.tags.join(", "));
	return parts.join(" · ");
}

export function AgentScorecardApp({
	config,
}: {
	config: AgentScorecardConfig;
}) {
	const query = useQuery({
		...osQuery.workItems.getAgentScorecard.queryOptions({
			input: config.projectId ? { projectId: config.projectId } : {},
		}),
		...workRefreshOptions,
		refetchInterval: 60_000,
	});
	const weekly = query.data?.weekly;
	return (
		<div
			className="grid min-w-0 gap-4"
			data-workspace-app-entry="agent-scorecard"
		>
			<PageHeader>
				<PageHeading>
					<PageTitle>Agent scorecard</PageTitle>
					<PageDescription>
						Each agent's last 7 days, per kind of task: what landed, what
						verified, what it cost and what people had to fix.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{query.isError ? (
				<WorkReadFailure
					title="Agent scorecard unavailable"
					error={query.error}
					onRetry={() => query.refetch()}
					retrying={query.isFetching}
				/>
			) : query.isPending ? (
				<div aria-busy="true" aria-label="Loading">
					<ListSkeleton rows={4} rowClassName="h-10" />
				</div>
			) : weekly?.rows.length ? (
				<Table
					scrollLabel="Weekly agent scorecard"
					mobileLayout="stacked"
					className="w-full table-fixed [&_td]:whitespace-normal [&_td]:break-words [&_th]:whitespace-normal"
				>
					<TableHeader>
						<TableRow>
							{[
								"Agent",
								"Kind of task",
								"Items",
								"Landed",
								"Verified",
								"First try",
								"Time to land",
								"Tokens / landed",
								"Cost / landed",
								"Human asks",
								"Fixed/reverted ≤7d",
							].map((label) => (
								<TableHead key={label} scope="col">
									{label}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{weekly.rows.map((row) => (
							<TableRow
								key={JSON.stringify([
									row.executor,
									row.model,
									row.size,
									row.risk,
									row.tags,
								])}
							>
								<TableCell label="Agent">
									<div>
										{names[row.executor] ?? row.executor}
										<br />
										<Text tone="secondary">{row.model ?? "Model unknown"}</Text>
									</div>
								</TableCell>
								<TableCell label="Kind of task">{kindLabel(row)}</TableCell>
								<TableCell label="Items">
									{row.items} ({row.attempts} attempts)
								</TableCell>
								<TableCell label="Landed">
									{percent(row.landedRate)} · {row.landedItems}
								</TableCell>
								<TableCell label="Verified">
									{percent(row.verifiedRate)}
								</TableCell>
								<TableCell label="First try">
									{percent(row.firstAttemptLandedRate)}
								</TableCell>
								<TableCell label="Time to land">
									{minutes(row.medianTimeToLandMs)}
								</TableCell>
								<TableCell label="Tokens / landed">
									{row.tokensPerLanded === null
										? "—"
										: compact.format(row.tokensPerLanded)}
								</TableCell>
								<TableCell label="Cost / landed">
									{cost(row.costPerLandedUsd)}
								</TableCell>
								<TableCell label="Human asks">
									{row.humanInterventions}
								</TableCell>
								<TableCell label="Fixed/reverted ≤7d">
									{row.fixedOrRevertedWithin7d ?? "—"}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<Text tone="secondary">No agent started work in the last 7 days.</Text>
			)}
			{weekly ? (
				<Text tone="secondary">
					Attempts started in the last 7 days, grouped by agent, model and task
					kind (size, risk and tags). Landed counts items whose Attempt settled
					with commits; verified means the result was verified after landing.
					First try is items landed by their first Attempt. — means unknown.
					Human asks are Work interactions created on the item during the week.
					Fixed/reverted counts landed items whose change was landed again or
					reverted within 7 days.
				</Text>
			) : null}
		</div>
	);
}
