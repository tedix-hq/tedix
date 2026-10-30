import { Brain, Package } from "@phosphor-icons/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
	SkillRun,
	SkillWorkflowArtifactSummary,
	SkillWorkflowStep,
} from "@tedix/api-contract/contracts/cognitive";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import {
	RUN_ERROR_HEADLINE_LENGTH,
	summarizeRunError,
} from "@tedix/api-contract/utils/run-error";
import type { ReactNode } from "react";
import { CostChip } from "@/components/cost-chip";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Empty } from "@/components/kumo/empty";
import { IconFrame } from "@/components/kumo/icon-frame";
import { MetricGrid, MetricItem } from "@/components/kumo/metric-grid";
import {
	Collection,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import {
	findSkillDefinitionHealth,
	partitionEventGates,
	RunEventGateRow,
	RunReconciliationPanel,
	RunToolCallRow,
} from "@/components/run-trace";
import type { osApi } from "@/lib/api";
import { callCostRunReading, queryReading } from "@/lib/cost-reading";
import { formatCount } from "@/lib/format";
import { formatDurationMs } from "@/lib/time";
import { cn } from "@/lib/utils";

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function RunStepRow({ step }: { step: SkillWorkflowStep }) {
	const detail: string[] = [step.kind.replace(/_/g, " ")];
	if (step.kind === "tool_call" && step.namespace && step.method) {
		detail.push(`${step.namespace}.${step.method}`);
	}
	if (step.attempt != null && step.attempt > 1) {
		detail.push(`attempt ${step.attempt}`);
	}
	const duration = formatDurationMs(step.durationMs);
	if (duration) detail.push(duration);
	detail.push(step.status ?? step.outcome);
	return (
		<li className="flex min-w-0 items-center gap-3 px-3 py-2">
			<span
				data-outcome={step.outcome}
				aria-hidden
				className={cn(
					"size-2 shrink-0 rounded-full bg-kumo-interact",
					step.outcome === "success" && "bg-kumo-success",
					step.outcome === "failure" && "bg-kumo-danger",
				)}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere">
				<Text as="strong" role="body" tone="strong" weight="medium">
					{step.name}
				</Text>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{detail.join(" · ")}
				</Text>
			</span>
		</li>
	);
}

export function RunArtifactRow({
	artifact,
}: {
	artifact: SkillWorkflowArtifactSummary;
}) {
	const detail = [
		artifact.mimeType,
		formatBytes(artifact.sizeBytes),
		artifact.outcome,
		artifact.storage === "r2" ? "stored file" : "inline",
	];
	if (artifact.sha256) detail.push(`sha256 ${artifact.sha256.slice(0, 12)}…`);
	return (
		<li className="flex min-w-0 items-center gap-3 px-3 py-2">
			<IconFrame appearance="fill">
				<Package size={18} />
			</IconFrame>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere">
				<Text as="strong" role="body" tone="strong" weight="medium">
					{artifact.path}
				</Text>
				<Text as="span" role="label" tone="secondary" className="tabular-nums">
					{detail.join(" · ")}
				</Text>
			</span>
		</li>
	);
}

export function RunRationaleRow({ record }: { record: RationaleRecord }) {
	const detail = [
		record.category,
		`confidence ${Math.round(record.confidence * 100)}%`,
		record.outcomeStatus,
	];
	if (record.workItemId) detail.push(`work item ${record.workItemId}`);
	return (
		<li className="flex min-w-0 items-start gap-3 px-3 py-2">
			<IconFrame appearance="fill">
				<Brain size={18} />
			</IconFrame>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere">
				<Text as="strong" role="body" tone="strong" weight="medium">
					{record.action}
				</Text>
				<Text as="span" role="label">
					{record.rationale}
				</Text>
				<Text as="span" role="label" tone="secondary">
					{detail.join(" · ")}
				</Text>
			</span>
		</li>
	);
}

export function RunRationaleEmpty({
	runId,
	workItemId,
}: {
	runId: string;
	workItemId: string | null;
}) {
	return (
		<Empty
			appearance="inline"
			title="No rationale records reference this run"
			description={`No recent decisions link to run ${runId}${workItemId ? ` (work item ${workItemId})` : ""}.`}
		/>
	);
}

export function RunDetailSectionHeader({
	title,
	description,
	count,
}: {
	title: string;
	description: string;
	count?: number;
}) {
	return (
		<SectionHeader>
			<SectionHeading>
				<span className="flex flex-wrap items-center gap-2">
					<SectionTitle>{title}</SectionTitle>
					{count !== undefined ? (
						<Badge variant="secondary">{count}</Badge>
					) : null}
				</span>
				<SectionDescription>{description}</SectionDescription>
			</SectionHeading>
		</SectionHeader>
	);
}

export function RunErrorAlert({ error }: { error: string }) {
	// One line on the page; the full stored text stays in Details.
	const summary = summarizeRunError(error, RUN_ERROR_HEADLINE_LENGTH);
	return (
		<Alert variant="destructive">
			<AlertTitle>Run error</AlertTitle>
			<AlertDescription className="min-w-0 truncate">
				{summary}
			</AlertDescription>
			{error !== summary && (
				<Collapsible>
					<CollapsibleDefaultTrigger className="-mx-2 w-fit">
						Details
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<CodeBlock code={error} lang="text" />
					</CollapsibleDefaultContent>
				</Collapsible>
			)}
		</Alert>
	);
}

type QueryState<T> = Pick<
	UseQueryResult<T>,
	"data" | "isPending" | "isError" | "error"
> &
	Partial<Pick<UseQueryResult<T>, "refetch" | "isFetching">>;

function RunEvidenceSection<T>({
	title,
	description,
	items,
	pending = false,
	error,
	onRetry,
	retrying,
	empty,
	renderItem,
}: {
	title: string;
	description: string;
	items?: T[];
	pending?: boolean;
	error?: Error | null;
	onRetry?: () => unknown;
	retrying?: boolean;
	empty: ReactNode;
	renderItem: (item: T) => ReactNode;
}) {
	return (
		<PageSection>
			<RunDetailSectionHeader
				title={title}
				description={description}
				count={items?.length}
			/>
			{pending && (
				<Skeleton
					className="h-14"
					aria-label={`Loading ${title.toLowerCase()}`}
				/>
			)}
			{error && (
				<LoadError
					title={`${title} could not be loaded`}
					error={error}
					onRetry={onRetry}
					retrying={retrying}
				/>
			)}
			{items &&
				(items.length > 0 ? (
					<Collection aria-label={title}>{items.map(renderItem)}</Collection>
				) : typeof empty === "string" ? (
					<Empty appearance="inline" title={empty} />
				) : (
					empty
				))}
		</PageSection>
	);
}

export function RunEvidenceSections({
	inspection,
	artifacts,
	rationale,
}: {
	inspection: Pick<
		Awaited<ReturnType<typeof osApi.skills.inspectWorkflowRun>>,
		"steps" | "toolCalls"
	> & { run: Pick<SkillRun, "id" | "workItemId"> };
	artifacts: QueryState<
		Awaited<ReturnType<typeof osApi.skills.listRunArtifacts>>
	>;
	rationale: QueryState<
		Awaited<ReturnType<typeof osApi.rationaleRecords.list>>
	>;
}) {
	const { run, steps, toolCalls } = inspection;
	const eventGates = partitionEventGates(steps);
	const gates = [...eventGates.waiting, ...eventGates.resolved];
	return (
		<>
			<RunEvidenceSection
				title="Steps"
				description="Step receipts in execution order."
				items={steps}
				empty="No steps recorded yet"
				renderItem={(step) => (
					<RunStepRow
						key={`${step.path}:${step.executionEpoch}:${step.count}`}
						step={step}
					/>
				)}
			/>
			<RunEvidenceSection
				title="Tool calls"
				description="Tool calls and their provider receipts."
				items={toolCalls}
				empty="This run made no tool calls"
				renderItem={(call) => (
					<RunToolCallRow
						key={`${call.path}:${call.executionEpoch}:${call.count}`}
						call={call}
					/>
				)}
			/>
			<RunEvidenceSection
				title="Event gates"
				description="Where the run waited for a response, and what it received."
				items={gates}
				empty="This run did not wait for an event"
				renderItem={(step) => (
					<RunEventGateRow
						key={`${step.path}:${step.executionEpoch}:${step.count}`}
						step={step}
					/>
				)}
			/>
			<RunEvidenceSection
				title="Artifacts"
				description="Saved output and file integrity records."
				items={artifacts.data?.artifacts}
				pending={artifacts.isPending}
				error={artifacts.isError ? artifacts.error : null}
				onRetry={artifacts.refetch}
				retrying={artifacts.isFetching}
				empty="This run produced no artifacts"
				renderItem={(artifact) => (
					<RunArtifactRow
						key={`${artifact.path}:${artifact.attempt}`}
						artifact={artifact}
					/>
				)}
			/>
			<RunEvidenceSection
				title="Rationale"
				description="Decisions linked to this run."
				items={
					rationale.data &&
					(rationale.data.data ?? []).filter(
						(record) => record.runId === run.id,
					)
				}
				pending={rationale.isPending}
				error={rationale.isError ? rationale.error : null}
				onRetry={rationale.refetch}
				retrying={rationale.isFetching}
				empty={
					<RunRationaleEmpty
						runId={run.id}
						workItemId={run.workItemId ?? null}
					/>
				}
				renderItem={(record) => (
					<RunRationaleRow key={record.id} record={record} />
				)}
			/>
		</>
	);
}

export function RunCostsSection({
	run,
	costs,
}: {
	run: Pick<SkillRun, "id" | "costSummary">;
	costs: QueryState<Awaited<ReturnType<typeof osApi.tediUsage.getCallCosts>>>;
}) {
	const rows = (costs.data?.costs ?? []).filter((row) => row.runId === run.id);
	// Preserve the list's provenance classifier: unpriced and quarantined rows
	// must never turn into an apparent spend total. Empty attribution is not zero.
	const reading =
		queryReading(costs) ??
		callCostRunReading(rows, { emptyReason: "no_attribution_path" });
	const tokens = rows.reduce((total, row) => total + row.totalTokens, 0);
	const summary = run.costSummary;
	return (
		<PageSection>
			<RunDetailSectionHeader
				title="Costs"
				description="Recorded usage and costs linked to this run."
			/>
			{summary == null && rows.length === 0 ? (
				<Empty
					appearance="inline"
					title="No cost evidence was recorded for this run"
				/>
			) : (
				<MetricGrid
					aria-label="Run cost summary"
					appearance="bounded"
					columns={summary ? (rows.length > 0 ? 6 : 4) : 2}
				>
					{summary && (
						<>
							<MetricItem label="Steps" value={summary.steps} />
							<MetricItem label="Tool calls" value={summary.toolCalls} />
							<MetricItem label="Retries" value={summary.retries} />
							{formatDurationMs(summary.wallMs) && (
								<MetricItem
									label="Duration"
									value={formatDurationMs(summary.wallMs)}
								/>
							)}
						</>
					)}
					{rows.length > 0 && (
						<>
							<MetricItem
								label="Cost"
								value={
									<CostChip
										reading={reading}
										subject="Ledger cost attributed to this run"
									/>
								}
							/>
							<MetricItem label="Tokens" value={formatCount(tokens)} />
						</>
					)}
				</MetricGrid>
			)}
		</PageSection>
	);
}

export function RunTechnicalSection({
	run,
	definitionHealth,
}: {
	run: SkillRun;
	definitionHealth: QueryState<
		Awaited<ReturnType<typeof osApi.workflows.listDefinitionHealth>>
	>;
}) {
	return (
		<PageSection>
			<Collapsible>
				<CollapsibleDefaultTrigger className="-mx-2 w-fit">
					Technical details
				</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent>
					<div className="grid gap-2 pt-2">
						<Text as="p" role="label" tone="secondary" className="m-0">
							Execution details, the last status check, and whether this run
							used the skill's current version.
						</Text>
						<RunReconciliationPanel
							run={run}
							definitionHealth={
								definitionHealth.data
									? findSkillDefinitionHealth(
											definitionHealth.data.health,
											run.skillId,
										)
									: undefined
							}
							definitionEvidenceTruncated={
								definitionHealth.data?.truncated ?? false
							}
						/>
						{definitionHealth.isError && (
							<Text as="p" role="label" tone="secondary" aria-live="polite">
								The skill's version check is unavailable:{" "}
								{definitionHealth.error?.message}
							</Text>
						)}
					</div>
				</CollapsibleDefaultContent>
			</Collapsible>
		</PageSection>
	);
}
