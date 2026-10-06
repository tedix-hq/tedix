import type {
	TediRunStatus,
	TediRuntimeEvent,
	TediRuntimeEventKind,
	TediRuntimeRef,
} from "../schemas/cognitive-runtime";
import type { KernelRuntimeEvent } from "../schemas/kernel-runtime";

export const DEFAULT_COGNITIVE_RUNTIME_BACKEND: TediRuntimeRef["backend"] =
	"cloudflare-agents";
export const DEFAULT_KERNEL_RUNTIME_BACKEND: TediRuntimeRef["backend"] =
	"custom";

const RUNTIME_ID_PREFIX = "runtime";

function nowIso(): string {
	return new Date().toISOString();
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runtimeTextFromContentParts(
	content: unknown,
	seen: WeakSet<object>,
	depth: number,
): string | undefined {
	if (typeof content === "string")
		return content.length > 0 ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	const parts = content
		.map((part) => {
			const record = recordFrom(part);
			if (!record) return undefined;
			return runtimeTextFromCandidate(
				record.text ?? record.content ?? record.value,
				seen,
				depth + 1,
			);
		})
		.filter((part): part is string => part !== undefined);
	const text = parts.join("\n");
	return text.length > 0 ? text : undefined;
}

function collectRuntimeTextCandidates(
	value: unknown,
	candidates: string[],
	seen: WeakSet<object>,
	depth: number,
): void {
	if (depth > 5 || value === undefined || value === null) return;
	if (typeof value === "string") {
		const text = nonEmptyString(value);
		if (text) candidates.push(text);
		return;
	}
	if (Array.isArray(value)) {
		const text = runtimeTextFromContentParts(value, seen, depth);
		if (text) candidates.push(text);
		return;
	}
	const record = recordFrom(value);
	if (!record) return;
	if (seen.has(record)) return;
	seen.add(record);

	for (const key of ["deltaText", "text", "content", "value"]) {
		collectRuntimeTextCandidates(record[key], candidates, seen, depth + 1);
	}
	for (const key of [
		"message",
		"assistantMessage",
		"sessionMessage",
		"delta",
		"data",
		"payload",
	]) {
		collectRuntimeTextCandidates(record[key], candidates, seen, depth + 1);
	}
}

function runtimeTextFromCandidate(
	value: unknown,
	seen: WeakSet<object>,
	depth: number,
): string | undefined {
	const candidates: string[] = [];
	collectRuntimeTextCandidates(value, candidates, seen, depth);
	return longestRuntimeText(candidates);
}

function longestRuntimeText(candidates: string[]): string | undefined {
	let best: string | undefined;
	for (const candidate of candidates) {
		if (!best || candidate.length > best.length) best = candidate;
	}
	return best;
}

/**
 * Pick the most complete assistant/user text exposed by a runtime frame.
 *
 * Runtime frames can carry both a short token-level field (`text`/`deltaText`)
 * and a richer nested `message.content` snapshot in the same payload. Runtime
 * projection and completion promotion should prefer the most complete text
 * rather than whichever field appears first.
 */
export function bestRuntimeText(...values: unknown[]): string | undefined {
	const candidates: string[] = [];
	const seen = new WeakSet<object>();
	for (const value of values) {
		collectRuntimeTextCandidates(value, candidates, seen, 0);
	}
	return longestRuntimeText(candidates);
}

function runtimeRef(input: {
	runtime?: TediRuntimeRef;
	runtimeBackend?: TediRuntimeRef["backend"];
	runtimeExternalId?: string;
	runtimeExternalUrl?: string;
	runtimeMetadata?: Record<string, unknown>;
	defaultBackend: TediRuntimeRef["backend"];
}): TediRuntimeRef {
	if (input.runtime) return input.runtime;
	return {
		backend: input.runtimeBackend ?? input.defaultBackend,
		externalId: input.runtimeExternalId,
		externalUrl: input.runtimeExternalUrl,
		metadata: input.runtimeMetadata,
	};
}

export function runtimeEventId(input: {
	artifactId?: string;
	approvalRequestId?: string;
	conversationId?: string;
	createdAt?: string;
	kind: string;
	messageId?: string;
	runId?: string;
	runtimeBackend?: TediRuntimeRef["backend"];
	sequence?: number;
	tediId: string;
	toolCallId?: string;
}): string {
	return [
		RUNTIME_ID_PREFIX,
		input.tediId,
		"event",
		input.runtimeBackend ?? DEFAULT_COGNITIVE_RUNTIME_BACKEND,
		input.kind,
		input.conversationId ?? "conversation",
		input.runId ?? "run",
		input.messageId ?? "message",
		input.toolCallId ??
			input.artifactId ??
			input.approvalRequestId ??
			input.sequence ??
			input.createdAt ??
			"event",
	].join(":");
}

export function homeRuntimeEventId(input: {
	artifactId?: string;
	childRunId?: string;
	conversationId: string;
	delegatedTediId?: string;
	kind: TediRuntimeEventKind;
	messageId?: string;
	organizationId: string;
	runId?: string;
	sequence?: number;
	suffix?: string;
	toolCallId?: string;
}): string {
	return [
		"home",
		input.organizationId,
		"event",
		input.kind,
		input.conversationId,
		input.runId ?? "run",
		input.messageId ??
			input.toolCallId ??
			input.artifactId ??
			input.childRunId ??
			input.delegatedTediId ??
			input.sequence ??
			input.suffix ??
			"event",
	].join(":");
}

export function buildTediRuntimeEvent(input: {
	id?: string;
	tediId: string;
	kind: TediRuntimeEventKind;
	conversationId?: string;
	runId?: string;
	messageId?: string;
	toolCallId?: string;
	approvalRequestId?: string;
	artifactId?: string;
	sequence?: number;
	delta?: string;
	payload?: Record<string, unknown>;
	runtime?: TediRuntimeRef;
	runtimeBackend?: TediRuntimeRef["backend"];
	runtimeExternalId?: string;
	runtimeExternalUrl?: string;
	runtimeMetadata?: Record<string, unknown>;
	createdAt?: string;
}): TediRuntimeEvent {
	const createdAt = input.createdAt ?? nowIso();
	const runtime = runtimeRef({
		runtime: input.runtime,
		runtimeBackend: input.runtimeBackend,
		runtimeExternalId: input.runtimeExternalId,
		runtimeExternalUrl: input.runtimeExternalUrl,
		runtimeMetadata: input.runtimeMetadata,
		defaultBackend: DEFAULT_COGNITIVE_RUNTIME_BACKEND,
	});
	return {
		id:
			input.id ??
			runtimeEventId({
				artifactId: input.artifactId,
				approvalRequestId: input.approvalRequestId,
				conversationId: input.conversationId,
				createdAt,
				kind: input.kind,
				messageId: input.messageId,
				runId: input.runId,
				runtimeBackend: runtime.backend,
				sequence: input.sequence,
				tediId: input.tediId,
				toolCallId: input.toolCallId,
			}),
		tediId: input.tediId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
		toolCallId: input.toolCallId,
		approvalRequestId: input.approvalRequestId,
		artifactId: input.artifactId,
		sequence: input.sequence,
		delta: input.delta,
		payload: input.payload,
		runtime,
		createdAt,
	};
}

export type TediTurnEventIdSuffix = number | "conv-created";

export function tediTurnRuntimeEventId(
	runId: string,
	suffix: TediTurnEventIdSuffix,
): string {
	return `${runId}:${suffix}`;
}

export function buildTediTurnRuntimeEvent(input: {
	id?: string;
	tediId: string;
	kind: TediRuntimeEventKind;
	conversationId: string;
	runId?: string;
	eventIdRunId?: string;
	messageId?: string;
	toolCallId?: string;
	approvalRequestId?: string;
	artifactId?: string;
	sequence?: number;
	idSuffix?: TediTurnEventIdSuffix;
	delta?: string;
	payload?: Record<string, unknown>;
	runtime?: TediRuntimeRef;
	runtimeBackend?: TediRuntimeRef["backend"];
	runtimeExternalId?: string;
	runtimeExternalUrl?: string;
	runtimeMetadata?: Record<string, unknown>;
	traceId?: string;
	createdAt?: string;
}): TediRuntimeEvent {
	const runtimeMetadata = input.traceId
		? { ...input.runtimeMetadata, traceId: input.traceId }
		: input.runtimeMetadata;
	const eventIdRunId = input.eventIdRunId ?? input.runId;
	return buildTediRuntimeEvent({
		id:
			input.id ??
			(input.idSuffix === undefined || eventIdRunId === undefined
				? undefined
				: tediTurnRuntimeEventId(eventIdRunId, input.idSuffix)),
		tediId: input.tediId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
		toolCallId: input.toolCallId,
		approvalRequestId: input.approvalRequestId,
		artifactId: input.artifactId,
		sequence: input.sequence,
		delta: input.delta,
		payload: input.payload,
		runtime: input.runtime,
		runtimeBackend: input.runtimeBackend,
		runtimeExternalId: input.runtimeExternalId,
		runtimeExternalUrl: input.runtimeExternalUrl,
		runtimeMetadata,
		createdAt: input.createdAt,
	});
}

export function buildKernelRuntimeEvent(input: {
	id?: string;
	organizationId: string;
	kind: TediRuntimeEventKind;
	conversationId: string;
	runId?: string;
	messageId?: string;
	causeEventId?: string | null;
	delegatedTediId?: string | null;
	childRunId?: string | null;
	sequence?: number;
	delta?: string;
	payload?: Record<string, unknown>;
	runtime?: TediRuntimeRef;
	runtimeBackend?: TediRuntimeRef["backend"];
	runtimeExternalId?: string;
	runtimeExternalUrl?: string;
	runtimeMetadata?: Record<string, unknown>;
	createdAt?: string;
}): KernelRuntimeEvent {
	const createdAt = input.createdAt ?? nowIso();
	const delegatedTediId = input.delegatedTediId ?? undefined;
	const childRunId = input.childRunId ?? undefined;
	const runtime = runtimeRef({
		runtime: input.runtime,
		runtimeBackend: input.runtimeBackend,
		runtimeExternalId: input.runtimeExternalId,
		runtimeExternalUrl: input.runtimeExternalUrl,
		runtimeMetadata: input.runtimeMetadata,
		defaultBackend: DEFAULT_KERNEL_RUNTIME_BACKEND,
	});
	return {
		id:
			input.id ??
			homeRuntimeEventId({
				artifactId: undefined,
				childRunId,
				conversationId: input.conversationId,
				delegatedTediId,
				kind: input.kind,
				messageId: input.messageId,
				organizationId: input.organizationId,
				runId: input.runId,
				sequence: input.sequence,
				suffix: createdAt,
			}),
		organizationId: input.organizationId,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
		causeEventId: input.causeEventId ?? undefined,
		delegatedTediId,
		childRunId,
		sequence: input.sequence,
		delta: input.delta,
		payload: input.payload,
		runtime,
		createdAt,
	};
}

export function isRunLifecycleEventKind(
	kind: string | null | undefined,
): kind is "run.started" | "run.completed" | "run.failed" | "run.canceled" {
	return (
		kind === "run.started" ||
		kind === "run.completed" ||
		kind === "run.failed" ||
		kind === "run.canceled"
	);
}

export function isTerminalRunEventKind(
	kind: string | null | undefined,
): kind is "run.completed" | "run.failed" | "run.canceled" {
	return (
		kind === "run.completed" || kind === "run.failed" || kind === "run.canceled"
	);
}

export function subagentOutcomeEventKind(
	status: TediRunStatus,
): "subagent.completed" | "subagent.failed" | null {
	if (status === "completed") return "subagent.completed";
	if (status === "failed" || status === "canceled") return "subagent.failed";
	return null;
}
