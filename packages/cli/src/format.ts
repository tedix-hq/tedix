export type TerminalOutput = Pick<Console, "log" | "error">;

import {
	type HomeRunEvent,
	type HomeRunSummary,
	isPendingHomeApproval,
	stringValue,
	summarizeHomePayload,
} from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";

import { renderMarkdown } from "./markdown";
import { type ColorMode, stripControlChars } from "./terminal";

// ─── Color ───────────────────────────────────────────────────────────────────

export function resolveColorMode(opts?: {
	isTty?: boolean;
	json?: boolean;
	noColor?: boolean;
}): ColorMode {
	if (opts?.json) return { enabled: false };
	if (opts?.noColor) return { enabled: false };
	if (process.env.NO_COLOR !== undefined) return { enabled: false };
	if (process.env.TERM === "dumb") return { enabled: false };
	const isTty =
		opts?.isTty !== undefined ? opts.isTty : process.stdout.isTTY === true;
	return { enabled: isTty };
}

function ansi(code: string, text: string, mode: ColorMode): string {
	if (!mode.enabled) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

export function green(text: string, mode: ColorMode): string {
	return ansi("32", text, mode);
}

export function red(text: string, mode: ColorMode): string {
	return ansi("31", text, mode);
}

export function yellow(text: string, mode: ColorMode): string {
	return ansi("33", text, mode);
}

export function cyan(text: string, mode: ColorMode): string {
	return ansi("36", text, mode);
}

export function dim(text: string, mode: ColorMode): string {
	return ansi("2", text, mode);
}

/**
 * Three-tier human duration: sub-second as `Xms`, under a minute as `X.Xs`,
 * longer as `Xm Y.Ys`. Used for the live elapsed clock on the spinner and
 * run-end timing.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = seconds - minutes * 60;
	return `${minutes}m ${rem.toFixed(1)}s`;
}

export function statusColor(
	status: string | undefined,
	mode: ColorMode,
): string {
	if (!status) return dim("(none)", mode);
	if (status === "completed") return green(status, mode);
	if (status === "failed" || status === "canceled") {
		return red(status, mode);
	}
	if (status === "requires_approval") return yellow(status, mode);
	if (status === "running" || status === "active" || status === "queued") {
		return cyan(status, mode);
	}
	return dim(status, mode);
}

// ─── Presentation helpers (migrated verbatim from index.ts) ──────────────────

export function routeKind(summary: HomeRunSummary): string | undefined {
	const routeKind = summary.kernelRoute?.routeKind;
	return typeof routeKind === "string" ? routeKind : undefined;
}

/**
 * The answer text a summary is responsible for showing.
 *
 * A child preview/result is newer than the parent's pre-dispatch ack. Prefer it
 * so approval cannot resurrect stale "not dispatched yet" copy.
 */
export function summaryAnswerText(summary: HomeRunSummary): string {
	return (
		(summary.childRunId && summary.childRunPreview
			? summary.childRunPreview
			: summary.assistantText || summary.childRunPreview) ?? ""
	);
}

/**
 * The part of the answer that is NOT already in the terminal's scrollback.
 *
 * The CLI's live region promotes stable blocks into scrollback while the run is
 * in flight and reports the prefix it committed. A committed line is immutable,
 * so the summary prints only what is left. A prefix that no longer matches the
 * canonical answer is ignored outright: the canonical message is the source of
 * truth and reprints in full rather than being silently truncated.
 */
export function unrenderedAnswerText(summary: HomeRunSummary): string {
	const text = summaryAnswerText(summary);
	const rendered = summary.renderedAnswerPrefix;
	if (!rendered || !text.startsWith(rendered)) return text;
	return text.slice(rendered.length).trim() ? text.slice(rendered.length) : "";
}

export function formatSummary(
	summary: HomeRunSummary,
	json: boolean,
	mode: ColorMode = { enabled: false },
): string[] {
	const lines: string[] = [];
	if (json) {
		lines.push(JSON.stringify(summary, null, 2));
		return lines;
	}
	const route = routeKind(summary);
	const statusToken = summary.status
		? `status=${statusColor(summary.status, mode)}`
		: null;
	const header = [
		`run=${summary.homeRunId}`,
		statusToken,
		route ? `route=${route}` : null,
		summary.targetTediLabel || summary.targetTediId
			? `target=${summary.targetTediLabel ?? summary.targetTediId}`
			: null,
		summary.delegatedTediId ? `delegated=${summary.delegatedTediId}` : null,
		summary.childRunId ? `child=${summary.childRunId}` : null,
		summary.workItemId ? `workItem=${summary.workItemId}` : null,
		summary.delegationStatus ? `delegation=${summary.delegationStatus}` : null,
	]
		.filter(Boolean)
		.join(" ");
	// The raw run=/status=/route= envelope is debug noise in normal chat — the
	// answer + any delegation/approval lines below carry what a user needs. Show
	// the technical header only under TEDIX_DEBUG.
	if (process.env.TEDIX_DEBUG === "1" || process.env.TEDIX_DEBUG === "true") {
		lines.push(`\n${header}`);
	}
	if (summary.progressDetail && summary.status !== "completed") {
		lines.push(summary.progressDetail);
	}
	if (summary.delegationError) {
		lines.push(`Delegation error: ${summary.delegationError}`);
	}
	if (
		(process.env.TEDIX_DEBUG === "1" || process.env.TEDIX_DEBUG === "true") &&
		summary.delegationMode &&
		!summary.childRunId
	) {
		lines.push(
			`Delegation decision: ${summary.delegationMode}${
				summary.delegationReason ? ` (${summary.delegationReason})` : ""
			}`,
		);
	}
	if (
		(process.env.TEDIX_DEBUG === "1" || process.env.TEDIX_DEBUG === "true") &&
		summary.delegationStatus &&
		!summary.childRunId
	) {
		lines.push(`Delegation status: ${summary.delegationStatus}`);
		if (summary.delegationResolution) {
			lines.push(
				`Delegation resolution: ${snippet(summary.delegationResolution, 220)}`,
			);
		}
	}
	if (
		(process.env.TEDIX_DEBUG === "1" || process.env.TEDIX_DEBUG === "true") &&
		summary.approvedDelegationWorkOrder
	) {
		const workOrder = summary.approvedDelegationWorkOrder;
		lines.push("Approved delegation work order:");
		if (workOrder.objective) {
			lines.push(`  objective: ${snippet(workOrder.objective, 220)}`);
		}
		if (workOrder.outputContract) {
			lines.push(`  output: ${snippet(workOrder.outputContract, 220)}`);
		}
	}
	const text = unrenderedAnswerText(summary);
	if (text) lines.push(`\n${renderMarkdown(text, mode)}`);
	if (isPendingHomeApproval(summary)) {
		lines.push(
			`\nApproval required. ${cyan(`/approve ${summary.homeRunId}`, mode)} or ${cyan(`/reject ${summary.homeRunId}`, mode)} (optionally add a note) — or from a shell, ${cyan(`tedix approve ${summary.homeRunId}`, mode)}.`,
		);
	}
	if (summary.status === "failed" && summary.workItemId) {
		lines.push(
			`\nRecovery available: ${cyan(`/retry ${summary.workItemId}`, mode)}. Use ${cyan(`/inspect ${summary.homeRunId}`, mode)} for full evidence first.`,
		);
	}
	lines.push("");
	return lines;
}

export function printSummary(
	summary: HomeRunSummary,
	json: boolean,
	mode: ColorMode = { enabled: false },
	sink: TerminalOutput = console,
): void {
	for (const line of formatSummary(summary, json, mode)) sink.log(line);
}

export function printUnknownPayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
) {
	const summary = summarizeHomePayload(payload);
	if (summary) {
		printSummary(summary, json, undefined, sink);
		return;
	}
	sink.log(
		json
			? JSON.stringify(payload ?? null, null, 2)
			: JSON.stringify(payload ?? null),
	);
}

export function arrayValue(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function snippet(value: unknown, maxLength = 140): string {
	if (maxLength <= 3) {
		const raw = stringValue(value) ?? "";
		return raw.slice(0, Math.max(0, maxLength));
	}
	const text =
		stripControlChars(stringValue(value) ?? "")
			.replace(/\s+/g, " ")
			.trim() ?? "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

export function metadataRouteKind(
	record: Record<string, unknown>,
): string | undefined {
	const metadata = isRecord(record.metadata) ? record.metadata : {};
	const route = isRecord(metadata.kernelRoute) ? metadata.kernelRoute : {};
	return stringValue(route.routeKind);
}

export function printRunSetPayload(
	payload: unknown,
	json: boolean,
	mode: ColorMode = { enabled: false },
	sink: TerminalOutput = console,
): boolean {
	if (json || !isRecord(payload) || !isRecord(payload.runSet)) return false;
	const runSet = payload.runSet;
	const runs = arrayValue(runSet.runs);
	const activeRunIds = Array.isArray(runSet.activeRunIds)
		? runSet.activeRunIds.filter((id): id is string => typeof id === "string")
		: [];
	sink.log(
		`\nconversation=${stringValue(runSet.conversationId) ?? "unknown"} runs=${runs.length} active=${activeRunIds.length}`,
	);
	for (const run of runs) {
		const progress = isRecord(run.progress) ? run.progress : {};
		const route = metadataRouteKind(run);
		const runStatus = stringValue(run.status);
		const line = [
			stringValue(run.id),
			runStatus ? `status=${statusColor(runStatus, mode)}` : null,
			route ? `route=${route}` : null,
			stringValue(run.delegatedTediId)
				? `delegated=${stringValue(run.delegatedTediId)}`
				: null,
			stringValue(run.childRunId)
				? `child=${stringValue(run.childRunId)}`
				: null,
			stringValue(progress.label)
				? `progress=${stringValue(progress.label)}`
				: null,
		]
			.filter(Boolean)
			.join(" ");
		sink.log(line);
		const detail = snippet(progress.detail, 180);
		if (detail) sink.log(`  ${detail}`);
	}
	if (activeRunIds.length > 0)
		sink.log(`activeRunIds=${activeRunIds.join(",")}`);
	sink.log("");
	return true;
}

export function printMessagesPayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
): boolean {
	if (json || !isRecord(payload)) return false;
	const messages = arrayValue(payload.messages);
	if (messages.length === 0 && !("messages" in payload)) return false;
	sink.log(`\nmessages=${messages.length}`);
	for (const message of messages) {
		const line = [
			stringValue(message.createdAt),
			stringValue(message.role) ?? "message",
			stringValue(message.status)
				? `status=${stringValue(message.status)}`
				: null,
			stringValue(message.runId) ? `run=${stringValue(message.runId)}` : null,
			stringValue(message.id),
		]
			.filter(Boolean)
			.join(" ");
		sink.log(line);
		const text = snippet(message.content, 220);
		if (text) sink.log(`  ${text}`);
	}
	const nextCursor = stringValue(payload.nextCursor);
	if (nextCursor) sink.log(`nextCursor=${nextCursor}`);
	sink.log("");
	return true;
}

export function printConversationsPayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
): boolean {
	if (json || !isRecord(payload)) return false;
	const conversations = arrayValue(payload.conversations);
	if (conversations.length === 0 && !("conversations" in payload)) return false;
	sink.log(`\nconversations=${conversations.length}`);
	for (const conversation of conversations) {
		const line = [
			stringValue(conversation.id),
			stringValue(conversation.status)
				? `status=${stringValue(conversation.status)}`
				: null,
			stringValue(conversation.channel)
				? `channel=${stringValue(conversation.channel)}`
				: null,
			numberValue(conversation.messageCount) !== undefined
				? `messages=${numberValue(conversation.messageCount)}`
				: null,
			stringValue(conversation.pinnedAt) ? "pinned" : null,
			stringValue(conversation.lastMessageAt)
				? `last=${stringValue(conversation.lastMessageAt)}`
				: null,
		]
			.filter(Boolean)
			.join(" ");
		sink.log(line);
		const title = snippet(conversation.title, 180);
		if (title) sink.log(`  ${title}`);
	}
	const nextCursor = stringValue(payload.nextCursor);
	if (nextCursor) sink.log(`nextCursor=${nextCursor}`);
	sink.log("");
	return true;
}

export function printTraceBundlesPayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
): boolean {
	if (json || !isRecord(payload)) return false;
	const bundles = arrayValue(payload.bundles);
	if (bundles.length === 0 && !("bundles" in payload)) return false;
	sink.log(`\ntraceBundles=${bundles.length}`);
	for (const bundle of bundles) {
		const outcome = isRecord(bundle.outcome) ? bundle.outcome : {};
		const line = [
			stringValue(bundle.id),
			stringValue(bundle.runId) ? `run=${stringValue(bundle.runId)}` : null,
			stringValue(bundle.harnessVersionId)
				? `harness=${stringValue(bundle.harnessVersionId)}`
				: null,
			stringValue(bundle.createdAt)
				? `created=${stringValue(bundle.createdAt)}`
				: null,
			stringValue(outcome.status)
				? `outcome=${stringValue(outcome.status)}`
				: null,
		]
			.filter(Boolean)
			.join(" ");
		sink.log(line);
		const summary = snippet(bundle.summary, 220);
		if (summary) sink.log(`  ${summary}`);
	}
	sink.log("");
	return true;
}

export function printChildEvidencePayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
): boolean {
	if (json || !isRecord(payload)) return false;
	const evidence = isRecord(payload.evidence) ? payload.evidence : null;
	if (!evidence) return false;
	const events = arrayValue(evidence.events);
	const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : [];
	const line = [
		`child=${stringValue(evidence.childRunId) ?? "unknown"}`,
		stringValue(evidence.delegatedTediId)
			? `delegated=${stringValue(evidence.delegatedTediId)}`
			: null,
		stringValue(evidence.status)
			? `status=${stringValue(evidence.status)}`
			: null,
		stringValue(evidence.latestEventKind)
			? `latest=${stringValue(evidence.latestEventKind)}`
			: null,
		stringValue(evidence.terminalEventKind)
			? `terminal=${stringValue(evidence.terminalEventKind)}`
			: null,
		stringValue(evidence.workItemId)
			? `workItem=${stringValue(evidence.workItemId)}`
			: null,
		`events=${events.length}`,
		`artifacts=${artifacts.length}`,
	]
		.filter(Boolean)
		.join(" ");
	sink.log(`\n${line}`);
	const preview = snippet(evidence.preview, 260);
	if (preview) sink.log(`  ${preview}`);
	for (const event of events.slice(0, 8)) {
		const eventLine = [
			stringValue(event.createdAt),
			stringValue(event.kind) ?? "event",
			stringValue(event.id),
		]
			.filter(Boolean)
			.join(" ");
		sink.log(eventLine);
		const payloadText = snippet(event.payload, 220);
		if (payloadText) sink.log(`  ${payloadText}`);
	}
	sink.log("");
	return true;
}

export function printChildTreePayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
): boolean {
	if (json || !isRecord(payload)) return false;
	const tree = isRecord(payload.tree) ? payload.tree : null;
	if (!tree) return false;
	const nodes = arrayValue(tree.nodes);
	sink.log(
		`\nconversation=${stringValue(tree.conversationId) ?? "unknown"} childNodes=${nodes.length}`,
	);
	const printNode = (node: Record<string, unknown>, prefix = "") => {
		const line = [
			`${prefix}${stringValue(node.label) ?? stringValue(node.id) ?? "node"}`,
			stringValue(node.status) ? `status=${stringValue(node.status)}` : null,
			node.active === true ? "active" : null,
			stringValue(node.homeRunId)
				? `home=${stringValue(node.homeRunId)}`
				: null,
			stringValue(node.delegatedTediId)
				? `delegated=${stringValue(node.delegatedTediId)}`
				: null,
			stringValue(node.childRunId)
				? `child=${stringValue(node.childRunId)}`
				: null,
		]
			.filter(Boolean)
			.join(" ");
		sink.log(line);
		for (const child of arrayValue(node.children)) {
			printNode(child, `${prefix}  `);
		}
	};
	for (const node of nodes) printNode(node);
	sink.log("");
	return true;
}

export function printReadPayload(
	payload: unknown,
	json: boolean,
	sink: TerminalOutput = console,
) {
	if (json) {
		sink.log(JSON.stringify(payload ?? null, null, 2));
		return;
	}
	if (printChildEvidencePayload(payload, json, sink)) return;
	if (printChildTreePayload(payload, json, sink)) return;
	if (printRunSetPayload(payload, json, undefined, sink)) return;
	if (printMessagesPayload(payload, json, sink)) return;
	if (printConversationsPayload(payload, json, sink)) return;
	if (printTraceBundlesPayload(payload, json, sink)) return;
	printUnknownPayload(payload, json, sink);
}

export interface InspectBundle {
	convergedTrace?: unknown;
	convergedTraceError?: string;
	childEvidence?: unknown;
	childEvidenceError?: string;
	childTree?: unknown;
	childTreeError?: string;
	homeRunId: string;
	run: unknown;
	summary: HomeRunSummary | null;
	traceBundles?: unknown;
	traceBundlesError?: string;
	/** Delegated tedi's OWN trace bundles (per-step usage, rationale/artifact
	 * ids, bundleUri) — the tedi-side half of the chain the kernel bundles
	 * don't carry. */
	tediTraceBundles?: unknown;
	tediTraceBundlesError?: string;
}

export interface InspectViewOptions {
	artifacts?: boolean;
	branch?: string;
	events?: boolean;
	trace?: boolean;
	workstations?: boolean;
}

export function errorText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	// Strip all leading oRPC/JSON-RPC code prefixes in a loop so stacked
	// prefixes (e.g. "BAD_REQUEST: NOT_FOUND: msg") are all removed.
	const PREFIX_RE =
		/^(BAD_REQUEST|NOT_FOUND|FORBIDDEN|UNAUTHORIZED|CONFLICT|INTERNAL_SERVER_ERROR|MCP error -?\d+):\s*/;
	let msg = raw.trim();
	let prev: string;
	do {
		prev = msg;
		msg = msg.replace(PREFIX_RE, "").trim();
	} while (msg !== prev);
	return msg;
}

function inspectTraceValue(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	return isRecord(value.trace) ? value.trace : value;
}

/**
 * Match a `--branch <id>` selector against one of a branch's identifying ids.
 * Exact match always wins; selectors of 4+ chars also match by prefix/suffix
 * in either direction, so both a copied id fragment and a longer/full child
 * branch id select the branch (branch rows may store a shortened form).
 */
export function branchIdMatches(value: unknown, selector: string): boolean {
	if (typeof value !== "string" || value.length === 0) return false;
	if (value === selector) return true;
	if (Math.min(value.length, selector.length) < 4) return false;
	return (
		value.startsWith(selector) ||
		value.endsWith(selector) ||
		selector.startsWith(value) ||
		selector.endsWith(value)
	);
}

function inspectTraceBranches(
	trace: Record<string, unknown>,
	branch?: string,
): Record<string, unknown>[] {
	const branches = Array.isArray(trace.branches)
		? trace.branches.filter(isRecord)
		: [];
	if (!branch) return branches;
	return branches.filter((item) =>
		[item.childRunId, item.delegatedTediId, item.workItemId].some((value) =>
			branchIdMatches(value, branch),
		),
	);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** Compact, stable projection for humans and selectively filtered JSON. */
export function inspectTraceProjection(
	bundle: InspectBundle,
	options: InspectViewOptions = {},
): Record<string, unknown> | null {
	const trace = inspectTraceValue(bundle.convergedTrace);
	if (!trace) return null;
	const branches = inspectTraceBranches(trace, options.branch).map(
		(branch) => ({
			delegatedTediId: branch.delegatedTediId ?? null,
			childRunId: branch.childRunId ?? null,
			workItemId: branch.workItemId ?? null,
			status: branch.status ?? "unknown",
			complete: branch.evidenceAvailable === true && branch.truncated !== true,
			events: stringArray(branch.eventIds).length,
			tools: stringArray(branch.toolEventIds).length,
			workstations: stringArray(branch.workstationEventIds).length,
			artifacts: stringArray(branch.artifactIds).length,
			...(options.events
				? {
						eventIds: stringArray(branch.eventIds),
						toolEventIds: stringArray(branch.toolEventIds),
					}
				: {}),
			...(options.workstations
				? { workstationEventIds: stringArray(branch.workstationEventIds) }
				: {}),
			...(options.artifacts
				? { artifactIds: stringArray(branch.artifactIds) }
				: {}),
		}),
	);
	return {
		homeRunId: trace.homeRunId ?? bundle.homeRunId,
		status: trace.status ?? bundle.summary?.status ?? "unknown",
		complete: trace.complete === true,
		gaps: stringArray(trace.gaps),
		health: isRecord(trace.health) ? trace.health : null,
		latency: isRecord(trace.latency) ? trace.latency : null,
		traceBundleId: trace.traceBundleId ?? null,
		branches,
		wakeReceipts: Array.isArray(trace.wakeReceipts)
			? trace.wakeReceipts.length
			: 0,
		synthesis: Array.isArray(trace.synthesis) ? trace.synthesis.length : 0,
		...(options.events
			? {
					parentEventIds: stringArray(trace.parentEventIds),
					eventIds: isRecord(trace.eventIds) ? trace.eventIds : {},
				}
			: {}),
		...(options.artifacts
			? { artifactIds: stringArray(trace.artifactIds) }
			: {}),
	};
}

// Runtime event ids carry their kind in the id suffix after the child run id.
// Shapes (see apps/tedi-runtime/src/do.ts and packages/mcp-client-core):
//   {runId}:tool.N.started|completed|failed
//   {runId}:step:N:{seq}          {runId}:directives:{seq}
//   {runId}:emptystop:N           {runId}:retry:N:{seq}
//   {runId}:progress:N:{seq}      {runId}:durable-code:…
//   {runId}:chat-recovery:…       {runId}:compaction:…
const EVENT_ID_GROUPS: ReadonlyArray<{ label: string; re: RegExp }> = [
	{ label: "tool.started", re: /:tool\.\d+\.started$/ },
	{ label: "tool.completed", re: /:tool\.\d+\.completed$/ },
	{ label: "tool.failed", re: /:tool\.\d+\.failed$/ },
	{ label: "step", re: /:step:/ },
	{ label: "directives", re: /:directives:/ },
	{ label: "emptystop", re: /:emptystop:/ },
	{ label: "retry", re: /:retry:/ },
	{ label: "progress", re: /:progress:/ },
	{ label: "durable-code", re: /:durable-code:/ },
	{ label: "chat-recovery", re: /:chat-recovery:/ },
	{ label: "compaction", re: /:compaction:/ },
];

/**
 * Group raw runtime event ids into a compact `kind ×count` summary line —
 * the readable fallback when the branch's events cannot be hydrated to full
 * event rows. Exported for tests.
 */
export function summarizeEventIdGroups(ids: string[]): string {
	const counts = new Map<string, number>();
	for (const id of ids) {
		const group =
			EVENT_ID_GROUPS.find(({ re }) => re.test(id))?.label ?? "other";
		counts.set(group, (counts.get(group) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([label, count]) => `${label} ×${count}`)
		.join(" · ");
}

/**
 * Hydrate a branch's event ids to full event rows from the bundle's
 * childEvidence lane, when that lane covers this branch's child run (the
 * inspect bundle only fetches evidence for the run's direct delegation).
 * Returns null when hydration is unavailable so the caller can fall back to
 * the grouped id summary.
 */
function branchEvidenceEvents(
	bundle: InspectBundle,
	childRunId: string | undefined,
): HomeRunEvent[] | null {
	if (!childRunId || !isRecord(bundle.childEvidence)) return null;
	const evidence = isRecord(bundle.childEvidence.evidence)
		? bundle.childEvidence.evidence
		: null;
	if (!evidence || stringValue(evidence.childRunId) !== childRunId) return null;
	const events = arrayValue(evidence.events);
	if (events.length === 0) return null;
	return events.map((event, index) => ({
		createdAt: stringValue(event.createdAt),
		id: stringValue(event.id),
		kind: stringValue(event.kind),
		offset: String(index),
		payload: event.payload,
	}));
}

/** One readable activity row per hydrated branch event: marker + kind/tool + timestamp. */
function renderBranchEventRow(event: HomeRunEvent): string {
	const { marker } = classifyEventCard(event.kind ?? "");
	return [`  ${marker} ${humanizeEventLabel(event)}`, event.createdAt]
		.filter(Boolean)
		.join("  ");
}

function printCompactInspectTrace(
	bundle: InspectBundle,
	options: InspectViewOptions,
	sink: TerminalOutput = console,
): void {
	const projection = inspectTraceProjection(bundle, options);
	if (!projection) {
		sink.log(bundle.convergedTraceError ?? "Trace evidence is unavailable.");
		return;
	}
	sink.log(
		`${projection.status} · ${projection.complete ? "complete" : "incomplete"} · ${isRecord(projection.health) ? String(projection.health.status ?? "unknown") : "unknown"} health · ${Array.isArray(projection.branches) ? projection.branches.length : 0} branch(es)`,
	);
	const gaps = stringArray(projection.gaps);
	if (gaps.length > 0) sink.log(`Gaps: ${gaps.join(", ")}`);
	const latency = isRecord(projection.latency) ? projection.latency : null;
	if (latency) {
		const parent =
			typeof latency.parentElapsedMs === "number"
				? formatDuration(latency.parentElapsedMs)
				: "n/a";
		const wake =
			typeof latency.maxWakeQueueMs === "number"
				? formatDuration(latency.maxWakeQueueMs)
				: "n/a";
		const convergence =
			typeof latency.finalWakeToSynthesisMs === "number"
				? formatDuration(latency.finalWakeToSynthesisMs)
				: "n/a";
		sink.log(
			`Latency: ${parent} total · ${wake} wake max · ${convergence} final wake → synthesis`,
		);
	}
	for (const item of Array.isArray(projection.branches)
		? projection.branches.filter(isRecord)
		: []) {
		sink.log(
			`- ${String(item.delegatedTediId ?? "tedi")} · ${String(item.status ?? "unknown")} · ${String(item.childRunId ?? "no child run")}`,
		);
		sink.log(
			`  ${String(item.events ?? 0)} events · ${String(item.tools ?? 0)} tools · ${String(item.workstations ?? 0)} workstation · ${String(item.artifacts ?? 0)} artifacts`,
		);
		if (options.events) {
			// Prefer hydrated event rows (kind + tool name + timestamp) from the
			// childEvidence lane; fall back to a compact per-kind count summary
			// parsed from the raw event ids. Never dump flat id joins — they are
			// unreadable. (--json keeps the raw eventIds/toolEventIds arrays.)
			const eventIds = stringArray(item.eventIds);
			const hydrated = branchEvidenceEvents(
				bundle,
				typeof item.childRunId === "string" ? item.childRunId : undefined,
			);
			if (hydrated) {
				for (const event of hydrated) sink.log(renderBranchEventRow(event));
			} else if (eventIds.length > 0) {
				sink.log(
					`  events (${eventIds.length}): ${summarizeEventIdGroups(eventIds)}`,
				);
			} else {
				sink.log("  events: none");
			}
		}
		if (options.workstations) {
			sink.log(
				`  workstation ids: ${stringArray(item.workstationEventIds).join(", ") || "none"}`,
			);
		}
		if (options.artifacts) {
			sink.log(
				`  artifact ids: ${stringArray(item.artifactIds).join(", ") || "none"}`,
			);
		}
	}
	if (options.branch && (projection.branches as unknown[]).length === 0) {
		sink.log(`No branch matched ${options.branch}.`);
		// List what IS selectable so the operator doesn't have to re-run --trace.
		const trace = inspectTraceValue(bundle.convergedTrace);
		const available = trace ? inspectTraceBranches(trace) : [];
		if (available.length > 0) {
			sink.log("Available branches:");
			for (const branch of available) {
				const ids = [
					stringValue(branch.childRunId),
					stringValue(branch.delegatedTediId),
					stringValue(branch.workItemId),
				].filter((id): id is string => typeof id === "string");
				sink.log(`  ${ids.join(" · ") || "(no ids)"}`);
			}
		}
	}
}

export function printInspectBundle(
	bundle: InspectBundle,
	json: boolean,
	options: InspectViewOptions = {},
	sink: TerminalOutput = console,
) {
	if (json) {
		if (options.trace) {
			const trace = inspectTraceValue(bundle.convergedTrace);
			if (trace && options.branch) {
				sink.log(
					JSON.stringify(
						{ ...trace, branches: inspectTraceBranches(trace, options.branch) },
						null,
						2,
					),
				);
				return;
			}
			sink.log(JSON.stringify(trace ?? null, null, 2));
			return;
		}
		const selected =
			options.branch ||
			options.events ||
			options.artifacts ||
			options.workstations
				? inspectTraceProjection(bundle, options)
				: bundle;
		sink.log(JSON.stringify(selected, null, 2));
		return;
	}

	// --branch scopes the text output to the selected branch: skip the full
	// Home-run summary and mark the active filter in the section header.
	if (options.branch) {
		sink.log(`\n== Execution trace · branch ${options.branch} ==`);
	} else {
		sink.log("\n== Home run ==");
		if (bundle.summary)
			printSummary(bundle.summary, false, { enabled: false }, sink);
		else printReadPayload(bundle.run, false, sink);
		sink.log("== Execution trace ==");
	}
	if (options.trace && bundle.convergedTrace) {
		const trace = inspectTraceValue(bundle.convergedTrace);
		printUnknownPayload(
			trace && options.branch
				? { ...trace, branches: inspectTraceBranches(trace, options.branch) }
				: bundle.convergedTrace,
			false,
			sink,
		);
	} else {
		printCompactInspectTrace(bundle, options, sink);
	}
	sink.log(
		"Use --trace for the full graph or --events, --artifacts, --workstations, and --branch <id> for focused evidence.",
	);
}

// ─── NDJSON event emitter ─────────────────────────────────────────────────────

/**
 * Emit one compact NDJSON line for the event, including its resume offset.
 * The default write fn sends to stdout; inject a custom writer for testing.
 */
export function emitEventNdjson(
	event: HomeRunEvent,
	write?: (line: string) => void,
): void {
	const line = JSON.stringify(event);
	const writeFn = write ?? ((l: string) => process.stdout.write(`${l}\n`));
	writeFn(line);
}

/**
 * Tool-call card classification for a run event — the ●/⎿ marker + a semantic
 * tone, grounded in the kernel runtime event kinds (TediRuntimeEventKindSchema).
 * `●` = a started/primary action, `⎿` = a result/sub-line, `·` = low-signal
 * infra. Pure + reused by the `tail` view (and, later, the live-turn cards).
 */
export type EventTone = "active" | "ok" | "error" | "warn" | "muted";

export function classifyEventCard(kind: string): {
	marker: string;
	tone: EventTone;
} {
	switch (kind) {
		case "tool.started":
		case "subagent.started":
		case "skill.used":
		case "skill.crystallized":
		case "decision.recorded":
		case "run.started":
		case "submission.attempt.started":
			return { marker: "●", tone: "active" };
		case "approval.requested":
			return { marker: "●", tone: "warn" };
		case "tool.completed":
		case "subagent.completed":
		case "step.completed":
		case "decision.completed":
		case "run.completed":
		case "artifact.created":
		case "approval.resolved":
		case "submission.admitted":
		case "submission.settled":
			return { marker: "⎿", tone: "ok" };
		case "tool.failed":
		case "subagent.failed":
		case "run.failed":
		case "run.canceled":
			return { marker: "⎿", tone: "error" };
		case "step.retry":
		case "submission.attempt.recovered":
		case "runtime.health_changed":
			return { marker: "⎿", tone: "warn" };
		default:
			// message.*/conversation.*/context.*/memory.*/task.* — infra noise.
			return { marker: "·", tone: "muted" };
	}
}

const EVENT_TONE_COLOR: Record<
	EventTone,
	(text: string, mode: ColorMode) => string
> = {
	active: cyan,
	ok: green,
	error: red,
	warn: yellow,
	muted: dim,
};

/**
 * A readable label for an event: the kind verbatim, plus a tool/subagent/skill
 * name dug from the payload when present (e.g. "tool.started · search_products").
 */
export function humanizeEventLabel(event: HomeRunEvent): string {
	const kind = event.kind ?? "event";
	const p = isRecord(event.payload) ? event.payload : {};
	const name =
		stringValue(p.toolName) ??
		stringValue(p.name) ??
		stringValue(p.skill) ??
		stringValue(p.tediLabel) ??
		stringValue(p.tediId) ??
		stringValue(p.subagentTediId);
	return name ? `${kind} · ${name}` : kind;
}

/**
 * Render a single run event as a ●/⎿ tool-call card: a toned marker + label,
 * then dim createdAt/offset context and an indented payload snippet.
 */
export function renderEventPretty(
	event: HomeRunEvent,
	mode: ColorMode = { enabled: false },
): string {
	const { marker, tone } = classifyEventCard(event.kind ?? "");
	const head = EVENT_TONE_COLOR[tone](
		`${marker} ${humanizeEventLabel(event)}`,
		mode,
	);
	const meta = [
		event.createdAt ? dim(event.createdAt, mode) : null,
		dim(`offset=${event.offset}`, mode),
	]
		.filter(Boolean)
		.join(" ");
	const header = meta ? `${head}  ${meta}` : head;
	const body = snippet(event.payload, 140);
	return body ? `${header}\n  ${body}` : header;
}
