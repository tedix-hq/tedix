import type { AppToolBreakdownSchema } from "@tedix/api-contract/contracts/analytics";
import type { z } from "zod";
import { Meter } from "@/components/kumo/meter";
import { Collection } from "@/components/kumo/page";
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
import { formatBytes, formatDuration } from "./format";

type AppToolBreakdown = z.infer<typeof AppToolBreakdownSchema>;

// =============================================================================
// Tool Breakdown Table
// =============================================================================

export function ToolBreakdownTable({
	tools,
}: {
	tools: AppToolBreakdown["tools"];
}) {
	const maxCalls = Math.max(...tools.map((tool) => tool.totalCalls), 1);

	return (
		<TooltipProvider>
			<Collection
				aria-label="Tool performance records"
				className="lg:hidden [&>li]:px-3 [&>li]:py-3"
			>
				{tools.map((tool) => (
					<ToolRecord key={tool.toolName} tool={tool} />
				))}
			</Collection>
			<div className="hidden lg:block">
				<Table scrollLabel="Tool performance breakdown">
					<TableHeader>
						<TableRow>
							<TableHead>Tool</TableHead>
							<TableHead className="text-right">Calls</TableHead>
							<TableHead className="text-right">Success</TableHead>
							<TableHead className="text-right">Failed</TableHead>
							<TableHead className="w-32">Success Rate</TableHead>
							<TableHead className="text-right">Avg Latency</TableHead>
							<TableHead className="text-right">Max Latency</TableHead>
							<TableHead className="text-right">Avg I/O</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{tools.map((tool) => (
							<ToolRow key={tool.toolName} tool={tool} maxCalls={maxCalls} />
						))}
					</TableBody>
				</Table>
			</div>
		</TooltipProvider>
	);
}

function ToolRecord({ tool }: { tool: AppToolBreakdown["tools"][number] }) {
	return (
		<li>
			<div className="flex min-w-0 items-start justify-between gap-3">
				<Text as="span" role="label" tone="mono" className="min-w-0 break-all">
					{tool.toolName}
				</Text>
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="shrink-0 tabular-nums"
				>
					{tool.totalCalls.toLocaleString()} calls
				</Text>
			</div>
			<div className="mt-3 flex items-center gap-3">
				<Meter
					label={`${tool.toolName} success rate`}
					hideLabel
					value={tool.successRate}
					className="h-2"
				/>
				<Text
					as="span"
					role="label"
					className="w-12 shrink-0 text-right tabular-nums"
				>
					{tool.successRate}%
				</Text>
			</div>
			<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
				<ToolRecordMetric
					label="Succeeded"
					value={tool.successCalls.toLocaleString()}
					valueClassName="text-kumo-success"
				/>
				<ToolRecordMetric
					label="Failed"
					value={tool.failedCalls.toLocaleString()}
					valueClassName={tool.failedCalls > 0 ? "text-kumo-danger" : undefined}
				/>
				<ToolRecordMetric
					label="Avg latency"
					value={formatDuration(tool.avgDurationMs)}
				/>
				<ToolRecordMetric
					label="Max latency"
					value={formatDuration(tool.maxDurationMs)}
					valueClassName={
						tool.maxDurationMs > 5000 ? "text-kumo-warning" : undefined
					}
				/>
				<ToolRecordMetric
					label="Avg input / output"
					value={`${formatBytes(tool.avgInputBytes)} / ${formatBytes(tool.avgOutputBytes)}`}
					className="col-span-2 sm:col-span-4"
				/>
			</dl>
		</li>
	);
}

function ToolRecordMetric({
	label,
	value,
	className,
	valueClassName,
}: {
	label: string;
	value: string;
	className?: string;
	valueClassName?: string;
}) {
	return (
		<div className={className}>
			<dt>
				<Text as="span" role="caption" tone="secondary">
					{label}
				</Text>
			</dt>
			<dd className="m-0 mt-0.5">
				<Text
					as="span"
					role="label"
					className={["tabular-nums", valueClassName].filter(Boolean).join(" ")}
				>
					{value}
				</Text>
			</dd>
		</div>
	);
}

function ToolRow({
	tool,
	maxCalls,
}: {
	tool: AppToolBreakdown["tools"][number];
	maxCalls: number;
}) {
	return (
		<TableRow>
			<TableCell>
				<Text as="span" role="label" tone="mono">
					{tool.toolName}
				</Text>
			</TableCell>
			<TableCell className="text-right">
				<div className="flex items-center justify-end gap-2">
					<div className="h-1.5 w-16 overflow-hidden rounded-full bg-kumo-fill">
						<div
							className="h-full rounded-full bg-kumo-brand"
							style={{ width: `${(tool.totalCalls / maxCalls) * 100}%` }}
						/>
					</div>
					<span className="tabular-nums">
						{tool.totalCalls.toLocaleString()}
					</span>
				</div>
			</TableCell>
			<TableCell className="text-right text-kumo-success tabular-nums">
				{tool.successCalls.toLocaleString()}
			</TableCell>
			<TableCell className="text-right tabular-nums">
				{tool.failedCalls > 0 ? (
					<Text as="span" role="body" tone="error">
						{tool.failedCalls.toLocaleString()}
					</Text>
				) : (
					<Text as="span" role="body" tone="secondary">
						0
					</Text>
				)}
			</TableCell>
			<TableCell>
				<Tooltip>
					<TooltipTrigger
						render={
							<div className="flex items-center gap-2">
								<Meter
									label={`${tool.toolName} success rate`}
									hideLabel
									value={tool.successRate}
									className="h-2"
								/>
								<Text
									as="span"
									role="label"
									className="w-12 text-right tabular-nums"
								>
									{tool.successRate}%
								</Text>
							</div>
						}
					/>
					<TooltipContent>
						{tool.successCalls} succeeded / {tool.failedCalls} failed
					</TooltipContent>
				</Tooltip>
			</TableCell>
			<TableCell className="text-right">
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="tabular-nums">
								{formatDuration(tool.avgDurationMs)}
							</span>
						}
					/>
					<TooltipContent>{tool.avgDurationMs}ms</TooltipContent>
				</Tooltip>
			</TableCell>
			<TableCell className="text-right">
				<Tooltip>
					<TooltipTrigger
						render={
							<Text
								as="span"
								role="body"
								tone={tool.maxDurationMs > 5000 ? "warning" : "default"}
								className="tabular-nums"
							>
								{formatDuration(tool.maxDurationMs)}
							</Text>
						}
					/>
					<TooltipContent>max: {tool.maxDurationMs}ms</TooltipContent>
				</Tooltip>
			</TableCell>
			<TableCell className="text-right text-kumo-subtle tabular-nums">
				<Tooltip>
					<TooltipTrigger
						render={
							<Text as="span" role="label">
								{formatBytes(tool.avgInputBytes)} /{" "}
								{formatBytes(tool.avgOutputBytes)}
							</Text>
						}
					/>
					<TooltipContent>
						avg request {formatBytes(tool.avgInputBytes)} · avg response{" "}
						{formatBytes(tool.avgOutputBytes)}
					</TooltipContent>
				</Tooltip>
			</TableCell>
		</TableRow>
	);
}
