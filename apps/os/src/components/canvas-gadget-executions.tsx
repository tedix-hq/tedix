import { DownloadSimple, Play, Receipt } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	OsGadgetExecution,
	OsGadgetExportDescriptor,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useEffect, useMemo, useRef, useState } from "react";
import * as z from "zod";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { CodeBlock } from "@/components/kumo/code";
import { FormField } from "@/components/kumo/forms/form-field";
import { jsonTextSchema } from "@/components/kumo/forms/json-text-schema";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { SelectItem } from "@/components/kumo/select";
import { Separator } from "@/components/kumo/separator";
import { Text } from "@/components/kumo/text";
import { CostChip } from "@/components/cost-chip";
import { ListSkeleton } from "@/components/list-skeleton";
import { SectionEyebrow } from "@/components/section-eyebrow";
import { osApi } from "@/lib/api";
import { gadgetCostReading } from "@/lib/cost-reading";
import { sentenceCase } from "@/lib/format";
import {
	gadgetExecutionsQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime } from "@/lib/time";

const GADGET_EXECUTION_LIMIT = 20;
const TEDI_LIST_LIMIT = 50;

const TERMINAL_EXECUTION_STATUSES = new Set([
	"denied",
	"completed",
	"failed",
	"canceled",
]);

const EXECUTION_VARIANTS: Record<OsGadgetExecution["status"], BadgeVariant> = {
	denied: "destructive",
	queued: "info",
	awaiting_approval: "warning",
	running: "info",
	paused: "secondary",
	completed: "success",
	failed: "destructive",
	canceled: "outline",
};

export type ParsedExecutionInput =
	| { ok: true; value?: JsonValue }
	| { ok: false; error: string };

/** Empty input is omitted; any supplied body must be valid JSON. */
export function parseExecutionInput(value: string): ParsedExecutionInput {
	if (value.trim() === "") return { ok: true };
	try {
		return { ok: true, value: JSON.parse(value) as JsonValue };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

const gadgetExecutionSchema = z.object({
	tediId: z.string().min(1, "Choose a tedi."),
	inputText: jsonTextSchema((value) => {
		const parsed = parseExecutionInput(value);
		if (!parsed.ok) throw new Error(`Input is not valid JSON: ${parsed.error}`);
		return parsed.value;
	}),
});

export function executionStatusVariant(
	status: OsGadgetExecution["status"],
): BadgeVariant {
	return EXECUTION_VARIANTS[status];
}

/** Project one canonical receipt output into the portable MCP Apps result shape. */
export function gadgetExecutionToolResult(
	execution: OsGadgetExecution,
): Record<string, unknown> | undefined {
	if (execution.output === null) return undefined;
	const structuredContent =
		typeof execution.output === "object" &&
		execution.output !== null &&
		!Array.isArray(execution.output)
			? execution.output
			: { value: execution.output };
	return {
		content: [{ type: "text", text: JSON.stringify(execution.output) }],
		structuredContent,
		_meta: {
			"tedix/execution": {
				id: execution.id,
				revision: execution.revision,
				status: execution.status,
				runId: execution.lineage.runId,
				workflowInstanceId: execution.lineage.workflowInstanceId,
			},
		},
	};
}

function JsonEvidence({ value }: { value: JsonValue }) {
	return (
		<CodeBlock
			className="max-h-56 overflow-auto"
			code={JSON.stringify(value, null, 2)}
			lang="json"
		/>
	);
}

function ReceiptDetail({
	execution,
	exportDescriptors,
}: {
	execution: OsGadgetExecution;
	exportDescriptors: OsGadgetExportDescriptor[];
}) {
	const lineage = execution.lineage;
	const exportExecution = useMutation({
		mutationFn: (exportId: string) =>
			osApi.osWorkspaces.executions.export({
				workspaceId: execution.workspaceId,
				gadgetId: execution.gadgetId,
				executionId: execution.id,
				exportId,
			}),
		onSuccess: (result) => {
			const download = document.createElement("a");
			download.href = result.url;
			download.download = result.fileName;
			download.rel = "noopener noreferrer";
			download.click();
		},
	});
	const lineageRows = [
		["Run", lineage.runId],
		["Workflow", lineage.workflowInstanceId],
		["Work Item", lineage.workItemId],
		["Approval", lineage.approvalRequestId],
		["Trace", lineage.traceBundleId],
		["Billing", lineage.billingReservationId],
	].filter((row): row is [string, string] => typeof row[1] === "string");

	return (
		<Card size="sm" data-execution-id={execution.id}>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					<Receipt size={16} /> Execution receipt
					<Badge variant={executionStatusVariant(execution.status)}>
						{sentenceCase(execution.status)}
					</Badge>
					<CostChip
						reading={gadgetCostReading({
							runId: execution.lineage.runId ?? null,
							costs: execution.costs,
						})}
						subject="Cost recorded on this Gadget receipt"
					/>
				</CardTitle>
				<CardDescription>
					Revision {execution.revision ?? "not admitted"} ·{" "}
					<span title={absoluteTime(execution.createdAt)}>
						{absoluteTime(execution.createdAt)}
					</span>
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-3">
				{execution.status === "completed" && exportDescriptors.length > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						<Text as="span" role="label" weight="medium">
							Downloads
						</Text>
						{exportDescriptors.map((descriptor) => (
							<Button
								key={descriptor.id}
								size="xs"
								variant="outline"
								disabled={exportExecution.isPending}
								onClick={() => exportExecution.mutate(descriptor.id)}
							>
								<DownloadSimple size={13} />
								{exportExecution.isPending &&
								exportExecution.variables === descriptor.id
									? `Preparing ${descriptor.label}…`
									: descriptor.label}
							</Button>
						))}
						{exportExecution.isError && (
							<Text as="span" role="label" className="text-kumo-danger">
								Export unavailable: {exportExecution.error.message}
							</Text>
						)}
					</div>
				)}
				<div className="grid gap-1">
					<Text as="span" role="label" weight="medium">
						Policy{" "}
						{execution.policyDecision.allowed ? "admitted" : "did not admit"}
					</Text>
					{execution.policyDecision.reasons.map((reason) => (
						<Text as="span" role="label" tone="secondary" key={reason}>
							{reason}
						</Text>
					))}
				</div>
				{lineageRows.length > 0 && (
					<dl className="m-0 grid gap-1 text-xs sm:grid-cols-2">
						{lineageRows.map(([label, value]) => (
							<div key={label} className="min-w-0">
								<Text as="dt" role="label" tone="secondary">
									{label}
								</Text>
								<Text
									as="dd"
									role="label"
									tone="mono"
									className="m-0 truncate"
									title={value}
								>
									{value}
								</Text>
							</div>
						))}
					</dl>
				)}
				{execution.output !== null && (
					<div className="grid gap-1">
						<Text as="span" role="label" weight="medium">
							Output
						</Text>
						<JsonEvidence value={execution.output} />
					</div>
				)}
				{execution.costs !== null && (
					<div className="grid gap-1">
						<Text as="span" role="label" weight="medium">
							Costs
						</Text>
						{/* Rendered as raw evidence on purpose. Current receipts carry
						    runtime `run.costSummary` — steps, attempts, tool calls,
						    durations, and NO money. Historical receipts without runtime
						    lineage may contain unattested JSON. Neither is a schema this
						    surface may read a dollar figure out of, so the chip above
						    says which kind it is and the JSON stays verbatim. */}
						<JsonEvidence value={execution.costs} />
					</div>
				)}
				{execution.error && (
					<Alert variant="destructive">
						<AlertTitle>Execution failed</AlertTitle>
						<AlertDescription>{execution.error}</AlertDescription>
					</Alert>
				)}
				{execution.evidenceRefs && execution.evidenceRefs.length > 0 && (
					<div className="grid gap-1">
						<Text as="span" role="label" weight="medium">
							Evidence
						</Text>
						<ul className="m-0 grid gap-1 pl-5">
							{execution.evidenceRefs.map((ref) => (
								<Text
									as="li"
									role="label"
									tone="mono-secondary"
									key={ref}
									className="break-all"
								>
									{ref}
								</Text>
							))}
						</ul>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

export function CanvasGadgetExecutions({
	workspaceId,
	gadgetId,
	exportDescriptors = [],
	exportRevision,
	onSelectedExecutionChange,
}: {
	workspaceId: string;
	gadgetId: string;
	exportDescriptors?: OsGadgetExportDescriptor[];
	exportRevision?: number;
	onSelectedExecutionChange?: (execution: OsGadgetExecution | null) => void;
}) {
	const queryClient = useQueryClient();
	const [latestExecution, setLatestExecution] =
		useState<OsGadgetExecution | null>(null);
	const idempotencyKeyRef = useRef<string | null>(null);

	const tedis = useQuery(tediRosterQueryOptions(TEDI_LIST_LIMIT));
	const activeTedis = useMemo(
		() => (tedis.data?.data ?? []).filter((tedi) => tedi.status === "active"),
		[tedis.data],
	);
	const executions = useQuery({
		...gadgetExecutionsQueryOptions(
			workspaceId,
			gadgetId,
			GADGET_EXECUTION_LIMIT,
		),
		refetchInterval: (query) =>
			query.state.data?.items.some(
				(execution) => !TERMINAL_EXECUTION_STATUSES.has(execution.status),
			)
				? 2_500
				: false,
	});

	const run = useMutation({
		mutationFn: (value: z.output<typeof gadgetExecutionSchema>) => {
			idempotencyKeyRef.current ??= crypto.randomUUID();
			return osApi.osWorkspaces.gadgets.run({
				workspaceId,
				gadgetId,
				tediId: value.tediId,
				...(value.inputText === undefined ? {} : { input: value.inputText }),
				idempotencyKey: idempotencyKeyRef.current,
			});
		},
		onSuccess: ({ execution }) => {
			setLatestExecution(execution);
			idempotencyKeyRef.current = null;
			void queryClient.invalidateQueries({
				queryKey: gadgetExecutionsQueryOptions(
					workspaceId,
					gadgetId,
					GADGET_EXECUTION_LIMIT,
				).queryKey,
			});
		},
	});
	const runForm = useZodForm({
		schema: gadgetExecutionSchema,
		defaultValues: { tediId: "", inputText: "{}" },
		onSubmit: ({ value }) => {
			run.reset();
			run.mutate(value);
		},
	});
	useEffect(() => {
		if (runForm.state.values.tediId === "" && activeTedis[0]) {
			runForm.setFieldValue("tediId", activeTedis[0].id);
		}
	}, [activeTedis, runForm]);

	const selectedExecution = latestExecution
		? (executions.data?.items.find(
				(execution) => execution.id === latestExecution.id,
			) ?? latestExecution)
		: (executions.data?.items[0] ?? null);
	const selectedExportDescriptors =
		selectedExecution &&
		(exportRevision === undefined ||
			selectedExecution.revision === exportRevision)
			? exportDescriptors
			: [];
	useEffect(() => {
		onSelectedExecutionChange?.(selectedExecution);
	}, [onSelectedExecutionChange, selectedExecution]);

	return (
		<section className="grid min-w-0 gap-3" data-gadget-executions>
			<SectionEyebrow
				title="Run and receipts"
				count={executions.data?.items.length}
			/>
			<Card size="sm">
				<CardHeader>
					<CardTitle>Governed run</CardTitle>
					<CardDescription>
						The selected tedi executes the pinned Gadget revision after
						capability, policy, budget, and approval admission.
					</CardDescription>
				</CardHeader>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						void runForm.handleSubmit();
					}}
				>
					<CardContent className="grid gap-3">
						{tedis.isPending && <ListSkeleton rows={1} rowClassName="h-9" />}
						{tedis.isError && (
							<Alert variant="destructive">
								<AlertTitle>Tedis are unavailable</AlertTitle>
								<AlertDescription>
									{(tedis.error as Error).message}
								</AlertDescription>
							</Alert>
						)}
						{tedis.data && activeTedis.length === 0 && (
							<Alert variant="warning">
								<AlertTitle>No active tedi can run this Gadget</AlertTitle>
								<AlertDescription>
									Activate a governed tedi before dispatching this revision.
								</AlertDescription>
							</Alert>
						)}
						{activeTedis.length > 0 && (
							<FormField form={runForm} name="tediId" label="Executing tedi">
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										{activeTedis.map((tedi) => (
											<SelectItem key={tedi.id} value={tedi.id}>
												{tedi.displayName ?? tedi.name} · {tedi.slug}
											</SelectItem>
										))}
									</FormSelect>
								)}
							</FormField>
						)}
						<FormField
							form={runForm}
							name="inputText"
							label="Gadget input JSON"
						>
							{(field, meta) => (
								<FormTextarea
									field={field}
									{...meta}
									aria-label="Gadget input JSON"
									rows={5}
									className="font-mono text-xs"
								/>
							)}
						</FormField>
						{run.isError && (
							<Alert variant="destructive">
								<AlertTitle>The Gadget could not be admitted</AlertTitle>
								<AlertDescription>
									{(run.error as Error).message}
								</AlertDescription>
							</Alert>
						)}
					</CardContent>
					{/*
					 * A standalone Separator rather than `border-t pt-3` on the footer:
					 * the Card root owns the vertical rhythm, so the divider sits inside
					 * the shared gap instead of stacking a second top padding on a part.
					 */}
					<Separator />
					<CardFooter className="justify-end">
						<Button type="submit" size="sm" disabled={run.isPending}>
							<Play size={14} /> {run.isPending ? "Admitting…" : "Run Gadget"}
						</Button>
					</CardFooter>
				</form>
			</Card>
			{executions.isPending && <ListSkeleton rows={2} />}
			{executions.isError && (
				<Alert variant="destructive">
					<AlertTitle>Execution history is unavailable</AlertTitle>
					<AlertDescription>
						{(executions.error as Error).message}
					</AlertDescription>
				</Alert>
			)}
			{selectedExecution && (
				<ReceiptDetail
					execution={selectedExecution}
					exportDescriptors={selectedExportDescriptors}
				/>
			)}
			{executions.data && executions.data.items.length > 1 && (
				<div className="grid gap-1">
					<Text as="span" role="label" weight="medium">
						Recent receipts
					</Text>
					<div className="flex flex-wrap gap-1">
						{executions.data.items.map((execution) => (
							<Button
								key={execution.id}
								variant="outline"
								size="xs"
								onClick={() => setLatestExecution(execution)}
							>
								{execution.id.slice(0, 8)} · {sentenceCase(execution.status)}
							</Button>
						))}
					</div>
				</div>
			)}
		</section>
	);
}
