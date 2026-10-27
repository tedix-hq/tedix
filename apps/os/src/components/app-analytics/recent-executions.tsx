import { useQuery } from "@tanstack/react-query";
import type { RecentExecutionsSchema } from "@tedix/api-contract/contracts/analytics";
import { CaretRight, Code } from "@phosphor-icons/react";
import { useId, useState } from "react";
import type { z } from "zod";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { executionDrilldownQueryOptions } from "@/lib/os-query-options";
import {
	coverageLabel,
	coverageTitle,
	formatDuration,
	formatTimestamp,
} from "./format";
import { ToolCallPayloadRow } from "./payloads";

type RecentExecutions = z.infer<typeof RecentExecutionsSchema>;

// =============================================================================
// Recent Executions
// =============================================================================

export function RecentExecutionsSection({
	executions,
}: {
	executions: RecentExecutions["executions"];
}) {
	const [expandedId, setExpandedId] = useState<string | null>(null);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Code size={16} aria-hidden />
					Recent Code Executions
					<Badge variant="outline" className="ml-1 font-normal">
						{executions.length} executions
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="px-0">
				<Table scrollLabel="Recent code mode executions">
					<TableHeader>
						<TableRow>
							<TableHead className="w-8" />
							<TableHead>Execution ID</TableHead>
							<TableHead className="text-right">Status</TableHead>
							<TableHead className="text-right">Tools</TableHead>
							<TableHead className="text-right">Duration</TableHead>
							<TableHead className="text-right">Time</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{executions.map((exec) => (
							<ExecutionRow
								key={exec.executionId}
								execution={exec}
								isExpanded={expandedId === exec.executionId}
								onToggle={() =>
									setExpandedId(
										expandedId === exec.executionId ? null : exec.executionId,
									)
								}
							/>
						))}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

function ExecutionRow({
	execution,
	isExpanded,
	onToggle,
}: {
	execution: RecentExecutions["executions"][number];
	isExpanded: boolean;
	onToggle: () => void;
}) {
	const detailsId = useId();

	return (
		<>
			<TableRow>
				<TableCell className="w-8 px-3">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={`${isExpanded ? "Collapse" : "Expand"} execution ${execution.executionId}`}
						aria-expanded={isExpanded}
						aria-controls={detailsId}
						onClick={onToggle}
						className="text-kumo-subtle"
						icon={
							<CaretRight
								aria-hidden
								size={16}
								className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
							/>
						}
					/>
				</TableCell>
				<TableCell>
					<Text
						as="span"
						role="label"
						tone="mono"
						title={execution.executionId}
					>
						{execution.executionId.slice(0, 8)}…
					</Text>
				</TableCell>
				<TableCell className="text-right">
					<Badge variant={execution.success ? "success" : "destructive"}>
						{execution.success ? "OK" : "Error"}
					</Badge>
				</TableCell>
				<TableCell className="text-right tabular-nums">
					{execution.toolCount}
				</TableCell>
				<TableCell className="text-right tabular-nums">
					{formatDuration(execution.durationMs)}
				</TableCell>
				<TableCell className="text-right text-kumo-subtle">
					{formatTimestamp(execution.timestamp)}
				</TableCell>
			</TableRow>
			{isExpanded && (
				<TableRow id={detailsId}>
					<TableCell colSpan={6} className="bg-kumo-fill p-0">
						<ExecutionDrilldownPanel executionId={execution.executionId} />
					</TableCell>
				</TableRow>
			)}
		</>
	);
}

// =============================================================================
// Execution Drill-Down
// =============================================================================

function ExecutionDrilldownPanel({ executionId }: { executionId: string }) {
	const { data, isPending, isError, error, refetch, isFetching } = useQuery({
		...executionDrilldownQueryOptions(executionId),
		staleTime: 300_000,
	});

	if (isPending) {
		return (
			<div className="px-4 py-3">
				<Skeleton className="h-16" />
			</div>
		);
	}

	if (isError) {
		return (
			<LoadError
				error={error}
				onRetry={() => refetch()}
				retrying={isFetching}
				title="Execution details could not be loaded"
				className="mx-4 my-3 w-auto"
			/>
		);
	}

	if (!data.execution && data.toolCalls.length === 0) {
		return (
			<div className="px-4 py-3 text-kumo-subtle text-xs">
				No data found for this execution.
			</div>
		);
	}

	return (
		<div className="space-y-2 px-4 py-3">
			{(data.actor || data.clientId || data.source === "analytics_engine") && (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-kumo-subtle text-tedix-caption">
					{data.attribution ? (
						<span
							className="min-w-0 max-w-full [overflow-wrap:anywhere]"
							title={data.attribution.actor.id}
						>
							by{" "}
							<Text as="span" role="caption" tone="default">
								{data.attribution.summary}
							</Text>
						</span>
					) : data.actor ? (
						<span className="min-w-0 max-w-full [overflow-wrap:anywhere]">
							by{" "}
							<Text
								as="span"
								role="caption"
								tone="mono"
								className="text-kumo-default"
							>
								{data.actor.actorType}:{data.actor.actorId}
							</Text>
						</span>
					) : null}
					{data.identityCoverage?.warnings.length ? (
						<span title={coverageTitle(data.identityCoverage)}>
							{coverageLabel(data.identityCoverage)}
						</span>
					) : null}
					{data.clientId && (
						<span className="min-w-0 max-w-full [overflow-wrap:anywhere]">
							via{" "}
							<Text as="span" role="caption" tone="mono">
								{data.clientId}
							</Text>
						</span>
					)}
					{data.traceId && (
						<Text
							as="span"
							role="caption"
							tone="mono"
							className="min-w-0 max-w-full [overflow-wrap:anywhere] opacity-70"
						>
							trace {data.traceId}
						</Text>
					)}
					{data.source === "analytics_engine" && (
						<Badge variant="outline">sampled (no actor)</Badge>
					)}
				</div>
			)}
			{data.execution && (
				<div className="flex min-w-0 items-center gap-3 rounded-md bg-kumo-tint px-3 py-2 text-xs">
					<Code size={14} aria-hidden className="shrink-0 text-kumo-subtle" />
					<Text
						as="span"
						role="label"
						tone="mono"
						className="min-w-0 flex-1 truncate"
						title={data.execution.toolName}
					>
						{data.execution.toolName}
					</Text>
					<Badge
						variant={data.execution.success ? "success" : "destructive"}
						className="shrink-0"
					>
						{data.execution.success ? "OK" : "Error"}
					</Badge>
					<Text
						as="span"
						role="label"
						tone="secondary"
						className="shrink-0 tabular-nums"
					>
						{formatDuration(data.execution.durationMs)}
					</Text>
				</div>
			)}
			{data.toolCalls.length > 0 && (
				<div className="space-y-1 border-kumo-line border-l-2 pl-4">
					{data.toolCalls.map((call, index) => (
						<ToolCallPayloadRow
							key={`${call.toolName}-${call.timestamp}-${index}`}
							executionId={executionId}
							toolName={call.toolName}
							success={call.success}
							durationMs={call.durationMs}
						/>
					))}
				</div>
			)}
		</div>
	);
}
