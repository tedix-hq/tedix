import {
	CaretDown,
	CaretRight,
	DownloadSimple,
	Play,
	Plus,
	X,
} from "@phosphor-icons/react";
import { AppCallLogs } from "@/components/app-call-logs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	OsGadgetExecution,
	OsGadgetExportDescriptor,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import * as z from "zod";
import { FormSelect } from "@/components/forms/form-select";
import { FormTextarea } from "@/components/forms/form-textarea";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { CodeBlock } from "@/components/kumo/code";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Empty } from "@/components/kumo/empty";
import { FormField } from "@/components/kumo/forms/form-field";
import { jsonTextSchema } from "@/components/kumo/forms/json-text-schema";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Input } from "@/components/kumo/input";
import { SelectItem } from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { ListSkeleton } from "@/components/list-skeleton";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { osApi } from "@/lib/api";
import { useOsFormattingPreferences, sentenceCase } from "@/lib/format";
import {
	gadgetExecutionsQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";
import { absoluteTime, formatDurationBetween, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ActorDirectory } from "@/lib/work-actor";

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

/** The plain word and dot colour a run shows in the list. */
const RUN_STATUS: Record<
	OsGadgetExecution["status"],
	{ label: string; dot: string }
> = {
	completed: { label: "Done", dot: "bg-kumo-success" },
	failed: { label: "Failed", dot: "bg-kumo-danger" },
	denied: { label: "Blocked", dot: "bg-kumo-danger" },
	running: { label: "Running", dot: "bg-kumo-brand motion-safe:animate-pulse" },
	queued: { label: "Starting", dot: "bg-kumo-brand" },
	awaiting_approval: { label: "Needs approval", dot: "bg-kumo-warning" },
	paused: { label: "Paused", dot: "bg-kumo-warning" },
	canceled: { label: "Canceled", dot: "bg-kumo-line" },
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

const connectionObservationSchema = z.object({
	kind: z.literal("connection_observation"),
	toolId: z.string(),
	providerId: z.string(),
	resourceName: z.string().nullish(),
	account: z.enum(["personal", "organization"]),
	actingUserId: z.string(),
	ownAccess: z.string(),
	mode: z.enum(["audit", "enforce"]),
	wouldDeny: z.boolean(),
	containsRestrictedData: z.boolean(),
});

const appCallInputSchema = z.object({
	method: z.string().min(1),
	args: z.unknown().optional(),
});

const OWN_ACCESS_LABELS: Record<string, string> = {
	own_account: "Read with their own account",
	not_checked: "Not checked for this account",
	verified: "Their own account can open it",
	unverified: "They have an account; this provider has no access check yet",
	no_linked_account: "They have no linked account",
	no_access: "Their own account cannot open it",
	check_failed: "The check could not finish",
};

function isTrace(execution: OsGadgetExecution): boolean {
	return execution.policyDecision.reasons.includes("runtime_trace");
}

function isAppCall(execution: OsGadgetExecution): boolean {
	return execution.grantedCapabilities.includes("app.call");
}

/** "rateItem" or "rate_item" → "Rate item". */
function actionLabel(method: string): string {
	return sentenceCase(
		method.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(),
	);
}

function firstName(name: string): string {
	return name.includes("@") ? name : (name.trim().split(/\s+/)[0] ?? name);
}

/** Who or what started a run, in the words a teammate would use. */
export function runStarter(
	execution: OsGadgetExecution,
	directory: ActorDirectory,
): string {
	const profile = directory.get(
		`${execution.createdByKind}:${execution.createdById}`,
	);
	const observation = connectionObservationSchema.safeParse(execution.input);
	if (observation.success) {
		const reader = directory.get(`user:${observation.data.actingUserId}`);
		const what = observation.data.resourceName ?? observation.data.toolId;
		return `${reader ? firstName(reader.name) : "Someone"} read ${what}`;
	}
	if (execution.createdByKind === "service")
		return execution.lineage.workflowInstanceId ? "Scheduled" : "Automatic";
	const who =
		execution.createdByKind === "user"
			? profile
				? firstName(profile.name)
				: "A teammate"
			: (profile?.name ??
				(execution.createdByKind === "tedi" ? "A tedi" : "An agent"));
	const call = appCallInputSchema.safeParse(execution.input);
	if (isAppCall(execution) && call.success)
		return `${who} clicked ${actionLabel(call.data.method)}`;
	return execution.createdByKind === "user" ? `${who} ran it` : who;
}

function shortValue(value: unknown): string {
	if (value === null) return "empty";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (Array.isArray(value))
		return `${value.length} ${value.length === 1 ? "item" : "items"}`;
	return `${Object.keys(value as object).length} fields`;
}

/** One line that says what the run produced, or why it did not. */
export function runSummary(execution: OsGadgetExecution): string {
	if (execution.error) return execution.error.split("\n")[0]!;
	switch (execution.status) {
		case "denied":
			return "Not allowed to run";
		case "awaiting_approval":
			return "Waiting for someone to approve it";
		case "queued":
			return "Waiting to start";
		case "running":
			return "Working…";
		case "paused":
			return "Paused";
		case "canceled":
			return "Canceled before it finished";
		case "failed":
			return "Stopped with an error";
	}
	const observation = connectionObservationSchema.safeParse(execution.input);
	if (observation.success)
		return `${observation.data.resourceName ?? observation.data.toolId} in ${observation.data.providerId}`;
	const output = execution.output;
	if (output === null) return "Finished with no output";
	if (typeof output !== "object" || Array.isArray(output))
		return shortValue(output);
	const entries = Object.entries(output);
	if (entries.length === 0) return "Finished with no output";
	return entries
		.slice(0, 3)
		.map(([key, value]) => `${key}: ${shortValue(value)}`)
		.join(" · ");
}

function Disclosure({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Collapsible>
			<CollapsibleTrigger className="group/disclosure -ml-2">
				<CaretDown
					size={12}
					aria-hidden
					className="transition-transform group-data-[panel-open]/disclosure:rotate-180"
				/>
				{label}
			</CollapsibleTrigger>
			<CollapsibleContent className="min-w-0 pt-2">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}

function RawJson({ value }: { value: JsonValue }) {
	return (
		<CodeBlock
			className="max-h-56 overflow-auto"
			code={JSON.stringify(value, null, 2)}
			lang="json"
		/>
	);
}

function FactList({ rows }: { rows: [string, ReactNode][] }) {
	return (
		<dl className="m-0 grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<Text as="dt" role="label" tone="secondary">
						{label}
					</Text>
					<Text as="dd" role="label" className="m-0 min-w-0 break-words">
						{value}
					</Text>
				</div>
			))}
		</dl>
	);
}

/** Input or output as readable fields, with the exact JSON one click away. */
function ValueSection({ title, value }: { title: string; value: JsonValue }) {
	const plain =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.entries(value)
			: null;
	return (
		<section className="grid min-w-0 gap-1.5" aria-label={title}>
			<Text as="h4" role="label" weight="medium">
				{title}
			</Text>
			{plain === null ? (
				<Text role="label" className="break-words">
					{shortValue(value)}
				</Text>
			) : plain.length === 0 ? (
				<Text role="label" tone="secondary">
					Nothing
				</Text>
			) : (
				<FactList
					rows={plain.map(([key, entry]) => [
						key,
						typeof entry === "object" && entry !== null ? (
							<code className="font-mono text-xs">{JSON.stringify(entry)}</code>
						) : (
							shortValue(entry)
						),
					])}
				/>
			)}
			<Disclosure label="Show raw">
				<RawJson value={value} />
			</Disclosure>
		</section>
	);
}

function ConnectionObservation({
	execution,
	directory,
}: {
	execution: OsGadgetExecution;
	directory: ActorDirectory;
}) {
	const parsed = connectionObservationSchema.safeParse(execution.input);
	if (!parsed.success) return null;
	const read = parsed.data;
	return (
		<FactList
			rows={[
				["Read", `${read.resourceName ?? read.toolId} in ${read.providerId}`],
				[
					"Account",
					read.account === "organization"
						? "Organization account"
						: "Reader's own account",
				],
				[
					"Reader",
					directory.get(`user:${read.actingUserId}`)?.name ?? read.actingUserId,
				],
				[
					"Own access",
					`${OWN_ACCESS_LABELS[read.ownAccess] ?? read.ownAccess}${
						read.wouldDeny && read.mode === "audit"
							? " (audit week: would be refused)"
							: ""
					}`,
				],
			]}
		/>
	);
}

function RunDetails({
	execution,
	exportDescriptors,
	directory,
}: {
	execution: OsGadgetExecution;
	exportDescriptors: OsGadgetExportDescriptor[];
	directory: ActorDirectory;
}) {
	const lineage = execution.lineage;
	const observation = connectionObservationSchema.safeParse(execution.input);
	const appCall = appCallInputSchema.safeParse(execution.input);
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
	const technicalRows = (
		[
			["Run ID", execution.id],
			["Version", execution.revision ? `Revision ${execution.revision}` : null],
			[
				"Permission check",
				`${execution.policyDecision.allowed ? "Allowed" : "Not allowed"}${
					execution.policyDecision.reasons.length > 0
						? ` (${execution.policyDecision.reasons.join(", ")})`
						: ""
				}`,
			],
			[
				"Permissions",
				execution.grantedCapabilities.length > 0
					? execution.grantedCapabilities.join(", ")
					: null,
			],
			["Runtime run", lineage.runId],
			["Automation", lineage.workflowInstanceId],
			["Work Item", lineage.workItemId],
			["Approval", lineage.approvalRequestId],
			["Trace", lineage.traceBundleId],
			["Billing", lineage.billingReservationId],
		] as [string, string | null][]
	).filter((row): row is [string, string] => typeof row[1] === "string");
	const evidence = execution.evidenceRefs ?? [];

	return (
		<div
			className="grid min-w-0 gap-4 border-kumo-hairline border-b bg-kumo-tint/40 px-3 pt-1 pb-4 sm:pl-7"
			data-execution-id={execution.id}
		>
			<Text role="caption" tone="secondary">
				{absoluteTime(execution.createdAt)}
				{execution.revision ? ` · Version ${execution.revision}` : ""}
			</Text>
			{observation.success && observation.data.containsRestrictedData && (
				<Badge variant="warning" className="w-fit">
					Contains restricted data
				</Badge>
			)}
			{execution.error && (
				<Alert variant="destructive">
					<AlertTitle>What went wrong</AlertTitle>
					<AlertDescription>{execution.error}</AlertDescription>
				</Alert>
			)}
			{execution.status === "denied" && !execution.error && (
				<Alert variant="destructive">
					<AlertTitle>This run was not allowed</AlertTitle>
					<AlertDescription>
						The app does not have permission to do this. Technical details below
						say which check stopped it.
					</AlertDescription>
				</Alert>
			)}
			{execution.status === "awaiting_approval" && (
				<Alert variant="warning">
					<AlertTitle>Waiting for approval</AlertTitle>
					<AlertDescription>
						It starts as soon as someone approves it.
					</AlertDescription>
				</Alert>
			)}
			{execution.status === "completed" && exportDescriptors.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<Text as="span" role="label" weight="medium">
						Download
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
						<Text as="span" role="label" tone="error">
							Download unavailable: {exportExecution.error.message}
						</Text>
					)}
				</div>
			)}
			{observation.success ? (
				<ConnectionObservation execution={execution} directory={directory} />
			) : appCall.success && isAppCall(execution) ? (
				<FactList
					rows={[
						["Action", actionLabel(appCall.data.method)],
						...(appCall.data.args !== undefined &&
						!(
							Array.isArray(appCall.data.args) && appCall.data.args.length === 0
						)
							? ([
									[
										"With",
										<code key="args" className="font-mono text-xs">
											{JSON.stringify(appCall.data.args)}
										</code>,
									],
								] as [string, ReactNode][])
							: []),
					]}
				/>
			) : (
				execution.input !== null && (
					<ValueSection title="Input" value={execution.input} />
				)
			)}
			{execution.output !== null && (
				<ValueSection title="Result" value={execution.output} />
			)}
			{isAppCall(execution) && (
				<AppCallLogs
					key={execution.id}
					workspaceId={execution.workspaceId}
					gadgetId={execution.gadgetId}
					callId={execution.id}
					finished={TERMINAL_EXECUTION_STATUSES.has(execution.status)}
				/>
			)}
			<Disclosure label="Technical details">
				<div className="grid min-w-0 gap-3">
					<FactList rows={technicalRows} />
					{execution.costs !== null && (
						<div className="grid gap-1">
							<Text as="span" role="label" tone="secondary">
								Usage recorded by the runtime (no price)
							</Text>
							{/* Raw on purpose: receipts carry runtime step counts and
							    durations, never money, so no figure is read out of it. */}
							<RawJson value={execution.costs} />
						</div>
					)}
					{evidence.length > 0 && (
						<div className="grid gap-1">
							<Text as="span" role="label" tone="secondary">
								Evidence
							</Text>
							<ul className="m-0 grid gap-1 pl-5">
								{evidence.map((ref) => (
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
				</div>
			</Disclosure>
		</div>
	);
}

function RunRow({
	execution,
	open,
	onToggle,
	directory,
	children,
}: {
	execution: OsGadgetExecution;
	open: boolean;
	onToggle: () => void;
	directory: ActorDirectory;
	children: ReactNode;
}) {
	const status = RUN_STATUS[execution.status];
	const duration = formatDurationBetween(
		execution.createdAt,
		execution.completedAt,
	);
	return (
		<li className="min-w-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className={cn(
					"grid w-full min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-kumo-hairline border-b px-3 py-2 text-left transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-focus motion-reduce:transition-none",
					open && "bg-kumo-tint/40",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					<CaretRight
						size={12}
						aria-hidden
						className={cn(
							"shrink-0 text-kumo-subtle transition-transform motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
					<span
						aria-hidden
						className={cn("size-2 shrink-0 rounded-full", status.dot)}
					/>
					<Text as="span" role="label" weight="medium" className="shrink-0">
						{status.label}
					</Text>
					<Text as="span" role="label" className="min-w-0 truncate">
						{runStarter(execution, directory)}
					</Text>
				</span>
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="text-right tabular-nums"
				>
					<time
						dateTime={execution.createdAt}
						title={absoluteTime(execution.createdAt)}
					>
						{relativeTime(execution.createdAt)}
					</time>
				</Text>
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="min-w-0 truncate pl-9"
				>
					{runSummary(execution)}
				</Text>
				<Text
					as="span"
					role="caption"
					tone="secondary"
					className="text-right tabular-nums"
				>
					{duration ?? ""}
				</Text>
			</button>
			{open && children}
		</li>
	);
}

type FieldRow = { id: number; key: string; value: string };

/** A typed value reads as its JSON type ("3", "true"); anything else is text. */
function fieldValue(value: string): JsonValue {
	try {
		const parsed = JSON.parse(value) as JsonValue;
		if (typeof parsed !== "object") return parsed;
	} catch {
		// Plain text.
	}
	return value;
}

function fieldsToJson(rows: FieldRow[]): string {
	const input: Record<string, JsonValue> = {};
	for (const row of rows)
		if (row.key.trim() !== "") input[row.key.trim()] = fieldValue(row.value);
	return JSON.stringify(input, null, 2);
}

/** Flat objects of plain values can be edited as fields; anything else stays JSON. */
function jsonToFields(text: string): FieldRow[] | null {
	const parsed = parseExecutionInput(text);
	if (!parsed.ok) return null;
	if (parsed.value === undefined) return [];
	const value = parsed.value;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return null;
	const rows: FieldRow[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "object" && entry !== null) return null;
		rows.push({
			id: rows.length,
			key,
			value: typeof entry === "string" ? entry : JSON.stringify(entry),
		});
	}
	return rows;
}

function RunManuallyForm({
	workspaceId,
	gadgetId,
	onStarted,
	onClose,
}: {
	workspaceId: string;
	gadgetId: string;
	onStarted: (execution: OsGadgetExecution) => void;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const idempotencyKeyRef = useRef<string | null>(null);
	const nextFieldId = useRef(1);
	const [mode, setMode] = useState<"fields" | "json">("fields");
	const [fields, setFields] = useState<FieldRow[]>([]);
	const tedis = useQuery(tediRosterQueryOptions(TEDI_LIST_LIMIT));
	const activeTedis = useMemo(
		() => (tedis.data?.data ?? []).filter((tedi) => tedi.status === "active"),
		[tedis.data],
	);
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
			idempotencyKeyRef.current = null;
			onStarted(execution);
			void queryClient.invalidateQueries({
				queryKey: gadgetExecutionsQueryOptions(
					workspaceId,
					gadgetId,
					GADGET_EXECUTION_LIMIT,
					{ includeTraces: false },
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
	const updateFields = (next: FieldRow[]) => {
		setFields(next);
		runForm.setFieldValue("inputText", fieldsToJson(next));
	};
	const editField = (id: number, patch: Partial<FieldRow>) =>
		updateFields(
			fields.map((row) => (row.id === id ? { ...row, ...patch } : row)),
		);
	const fieldsFromJson =
		mode === "json" ? jsonToFields(runForm.state.values.inputText) : null;

	return (
		<form
			className="grid min-w-0 gap-3 rounded-lg border border-kumo-hairline bg-kumo-base p-3"
			aria-label="Run manually"
			onSubmit={(event) => {
				event.preventDefault();
				void runForm.handleSubmit();
			}}
		>
			<div className="flex items-center justify-between gap-2">
				<Text as="h3" role="label" weight="medium">
					Run manually
				</Text>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label="Close"
					onClick={onClose}
				>
					<X size={12} />
				</Button>
			</div>
			{tedis.isPending && <ListSkeleton rows={1} rowClassName="h-9" />}
			{tedis.isError && (
				<LoadError
					title="Tedis are unavailable"
					error={tedis.error}
					onRetry={() => {
						void tedis.refetch();
					}}
					retrying={tedis.isFetching}
				/>
			)}
			{tedis.data && activeTedis.length === 0 && (
				<Alert variant="warning">
					<AlertTitle>No tedi can run this app yet</AlertTitle>
					<AlertDescription>Turn on a tedi first.</AlertDescription>
				</Alert>
			)}
			{activeTedis.length > 0 && (
				<FormField form={runForm} name="tediId" label="Run as">
					{(field, meta) => (
						<FormSelect
							field={field}
							{...meta}
							items={activeTedis.map((tedi) => ({
								value: tedi.id,
								label: tedi.displayName ?? tedi.name,
							}))}
						>
							{activeTedis.map((tedi) => (
								<SelectItem key={tedi.id} value={tedi.id}>
									{tedi.displayName ?? tedi.name}
								</SelectItem>
							))}
						</FormSelect>
					)}
				</FormField>
			)}
			{mode === "fields" ? (
				<div className="grid min-w-0 gap-2">
					<Text as="span" role="label" weight="medium">
						Input
					</Text>
					{fields.length === 0 && (
						<Text role="caption" tone="secondary">
							No input. Add a field if the app expects one.
						</Text>
					)}
					{fields.map((row, index) => (
						<div
							key={row.id}
							className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2"
						>
							<Input
								size="sm"
								aria-label={`Field ${index + 1} name`}
								placeholder="Name"
								value={row.key}
								onChange={(event) =>
									editField(row.id, { key: event.target.value })
								}
							/>
							<Input
								size="sm"
								aria-label={`Field ${index + 1} value`}
								placeholder="Value"
								value={row.value}
								onChange={(event) =>
									editField(row.id, { value: event.target.value })
								}
							/>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={`Remove field ${index + 1}`}
								onClick={() =>
									updateFields(
										fields.filter((candidate) => candidate.id !== row.id),
									)
								}
							>
								<X size={12} />
							</Button>
						</div>
					))}
					<div className="flex flex-wrap gap-1">
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={() =>
								updateFields([
									...fields,
									{ id: nextFieldId.current++, key: "", value: "" },
								])
							}
						>
							<Plus size={12} /> Add field
						</Button>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={() => setMode("json")}
						>
							Edit as JSON
						</Button>
					</div>
				</div>
			) : (
				<div className="grid min-w-0 gap-1">
					<FormField form={runForm} name="inputText" label="Input as JSON">
						{(field, meta) => (
							<FormTextarea
								field={field}
								{...meta}
								aria-label="Input as JSON"
								rows={4}
								className="font-mono text-xs"
							/>
						)}
					</FormField>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						className="w-fit"
						disabled={fieldsFromJson === null}
						title={
							fieldsFromJson === null
								? "Nested JSON can only be edited as JSON"
								: undefined
						}
						onClick={() => {
							if (!fieldsFromJson) return;
							nextFieldId.current = fieldsFromJson.length;
							setFields(fieldsFromJson);
							setMode("fields");
						}}
					>
						Use simple fields
					</Button>
				</div>
			)}
			{run.isError && (
				<Alert variant="destructive">
					<AlertTitle>The run could not start</AlertTitle>
					<AlertDescription>{(run.error as Error).message}</AlertDescription>
				</Alert>
			)}
			<div className="flex justify-end">
				<Button
					type="submit"
					size="sm"
					disabled={run.isPending || activeTedis.length === 0}
				>
					<Play size={14} /> {run.isPending ? "Starting…" : "Run"}
				</Button>
			</div>
		</form>
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
	useOsFormattingPreferences();
	const directory = useContext(WorkActorDirectoryContext);
	const [openId, setOpenId] = useState<string | null>(null);
	const [started, setStarted] = useState<OsGadgetExecution | null>(null);
	const [formOpen, setFormOpen] = useState(false);

	const executions = useQuery({
		...gadgetExecutionsQueryOptions(
			workspaceId,
			gadgetId,
			GADGET_EXECUTION_LIMIT,
			{ includeTraces: false },
		),
		refetchInterval: (query) =>
			query.state.data?.items.some(
				(execution) =>
					isAppCall(execution) ||
					(!isTrace(execution) &&
						!TERMINAL_EXECUTION_STATUSES.has(execution.status)),
			)
				? 2_500
				: false,
	});
	const runs = useMemo(() => {
		const listed = (executions.data?.items ?? []).filter(
			(execution) => !isTrace(execution),
		);
		// A manual run shows at once, before the list catches up with it.
		return started && !listed.some((execution) => execution.id === started.id)
			? [started, ...listed]
			: listed;
	}, [executions.data, started]);

	// The app preview follows the open run, else the newest one.
	const selectedExecution =
		runs.find((execution) => execution.id === openId) ?? runs[0] ?? null;
	useEffect(() => {
		onSelectedExecutionChange?.(selectedExecution);
	}, [onSelectedExecutionChange, selectedExecution]);

	return (
		<section className="grid min-w-0 gap-3" data-gadget-executions>
			<div className="flex min-w-0 items-center justify-between gap-2">
				<Text as="h2" role="label" tone="secondary">
					{runs.length > 0
						? `${runs.length} recent ${runs.length === 1 ? "run" : "runs"}`
						: "Runs"}
				</Text>
				{!formOpen && (
					<Button size="xs" variant="outline" onClick={() => setFormOpen(true)}>
						<Play size={12} /> Run manually
					</Button>
				)}
			</div>
			{formOpen && (
				<RunManuallyForm
					workspaceId={workspaceId}
					gadgetId={gadgetId}
					onClose={() => setFormOpen(false)}
					onStarted={(execution) => {
						setStarted(execution);
						setOpenId(execution.id);
						setFormOpen(false);
					}}
				/>
			)}
			{executions.isPending && <ListSkeleton rows={3} />}
			{executions.isError && (
				<LoadError
					title="History is unavailable"
					error={executions.error}
					onRetry={() => {
						void executions.refetch();
					}}
					retrying={executions.isFetching}
				/>
			)}
			{executions.data && runs.length === 0 && (
				<Empty
					appearance="quiet"
					title="No runs yet"
					description="Runs appear here when someone uses the app, a schedule runs, or you run it manually."
				/>
			)}
			{runs.length > 0 && (
				<ul
					aria-label="Runs"
					className="m-0 min-w-0 list-none overflow-hidden rounded-lg border border-kumo-hairline p-0 [&>li:last-child>button]:border-b-0"
				>
					{runs.map((execution) => (
						<RunRow
							key={execution.id}
							execution={execution}
							directory={directory}
							open={openId === execution.id}
							onToggle={() =>
								setOpenId(openId === execution.id ? null : execution.id)
							}
						>
							<RunDetails
								execution={execution}
								directory={directory}
								exportDescriptors={
									exportRevision === undefined ||
									execution.revision === exportRevision
										? exportDescriptors
										: []
								}
							/>
						</RunRow>
					))}
				</ul>
			)}
		</section>
	);
}
