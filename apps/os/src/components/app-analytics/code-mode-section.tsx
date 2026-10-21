import type { CodemodeAnalyticsSummarySchema } from "@tedix/api-contract/schemas/analytics";
import { Code } from "@phosphor-icons/react";
import type { z } from "zod";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Meter } from "@/components/kumo/meter";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { formatDuration } from "./format";

type CodemodeSummary = z.infer<typeof CodemodeAnalyticsSummarySchema>;
type CodeModeRow =
	| CodemodeSummary["topTools"][number]
	| CodemodeSummary["byNamespace"][number];

// =============================================================================
// Code Mode Analytics (Analytics Engine — codemode rpc/exec events)
// =============================================================================

function CodeModeStatTile({ label, value }: { label: string; value: string }) {
	return (
		<Card size="sm">
			<CardContent>
				<Text
					as="p"
					role="label"
					tone="secondary"
					weight="medium"
					className="m-0"
				>
					{label}
				</Text>
				<Text as="p" role="metric" weight="semibold" className="mt-1.5 mb-0">
					{value}
				</Text>
			</CardContent>
		</Card>
	);
}

function CodeModeBreakdownTable({
	rows,
	kind,
}: {
	rows: CodeModeRow[];
	kind: "tool" | "namespace";
}) {
	const maxCalls = Math.max(...rows.map((row) => row.totalCalls), 1);
	return (
		<TooltipProvider>
			<Table
				scrollLabel={`${kind === "tool" ? "Tool" : "Namespace"} activity breakdown`}
			>
				<TableHeader>
					<TableRow>
						<TableHead>{kind === "tool" ? "Tool" : "Namespace"}</TableHead>
						<TableHead className="text-right">Calls</TableHead>
						<TableHead className="w-32">Success Rate</TableHead>
						<TableHead className="text-right">Avg Latency</TableHead>
						{kind === "tool" && (
							<TableHead className="text-right">p50</TableHead>
						)}
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => {
						const name = "toolName" in row ? row.toolName : row.namespace;
						return (
							<TableRow key={name}>
								<TableCell>
									<Text as="span" role="label" tone="mono">
										{name}
									</Text>
								</TableCell>
								<TableCell className="text-right">
									<div className="flex items-center justify-end gap-2">
										<div className="h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
											<div
												className="h-full rounded-full bg-kumo-brand"
												style={{
													width: `${(row.totalCalls / maxCalls) * 100}%`,
												}}
											/>
										</div>
										<span className="tabular-nums">
											{row.totalCalls.toLocaleString()}
										</span>
									</div>
								</TableCell>
								<TableCell>
									<Tooltip>
										<TooltipTrigger
											render={
												<div className="flex items-center gap-2">
													<Meter
														label={`${name} success rate`}
														hideLabel
														value={row.successRate}
														className="h-2"
													/>
													<Text
														as="span"
														role="label"
														className="w-12 text-right tabular-nums"
													>
														{row.successRate}%
													</Text>
												</div>
											}
										/>
										<TooltipContent>
											{row.successCalls} succeeded / {row.failedCalls} failed
										</TooltipContent>
									</Tooltip>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{formatDuration(row.avgDurationMs)}
								</TableCell>
								{kind === "tool" && "p50DurationMs" in row && (
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.p50DurationMs)}
									</TableCell>
								)}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</TooltipProvider>
	);
}

export function CodeModeAnalyticsSection({
	summary,
}: {
	summary: CodemodeSummary;
}) {
	const { execSummary: ex, byNamespace, topTools } = summary;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Code size={16} aria-hidden />
					Code Mode
					<Badge variant="outline" className="ml-1 font-normal">
						{ex.totalExecs.toLocaleString()} execs
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-6 px-0">
				<div className="grid grid-cols-2 gap-4 px-4 sm:grid-cols-4">
					<CodeModeStatTile
						label="Executions"
						value={ex.totalExecs.toLocaleString()}
					/>
					<CodeModeStatTile
						label="Exec Success"
						value={`${ex.successRate.toFixed(1)}%`}
					/>
					<CodeModeStatTile
						label="Avg Tools/Exec"
						value={ex.avgToolCount.toFixed(1)}
					/>
					<CodeModeStatTile
						label="Avg Namespaces"
						value={ex.avgNamespaceCount.toFixed(1)}
					/>
				</div>
				{byNamespace.length > 0 && (
					<div>
						<Text
							as="p"
							role="label"
							tone="secondary"
							weight="medium"
							className="m-0 px-4 pb-2"
						>
							By namespace
						</Text>
						<CodeModeBreakdownTable rows={byNamespace} kind="namespace" />
					</div>
				)}
				{topTools.length > 0 && (
					<div>
						<Text
							as="p"
							role="label"
							tone="secondary"
							weight="medium"
							className="m-0 px-4 pb-2"
						>
							Top tools
						</Text>
						<CodeModeBreakdownTable rows={topTools} kind="tool" />
					</div>
				)}
			</CardContent>
		</Card>
	);
}
