import {
	type BaseContext,
	ErrorCodes,
	createError,
	withAuth,
	withServiceAuth,
} from "../../orpc";
import {
	DEFAULT_COGNITIVE_RUNTIME_BACKEND,
	buildTediRuntimeEvent,
} from "@tedix/api-contract/utils/runtime-events";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import type { KernelDO } from "../../../kernel/kernel-do";
import {
	RUNTIME_CONTROL_ID_RE,
	canonicalizeAgentSessionKey,
} from "@tedix/api-contract/utils/runtime-identity";
import {
	type TediApprovalRequestRow,
	type TediArtifactRow,
	type TediRuntimeEventInsert,
	type TediRuntimeEventKind,
	type TediRuntimeEventRow,
	enqueueKernelChildWake,
	getMappedDispatchRunId,
	getTediRuntimeEventById,
	insertTediRuntimeEvent,
} from "@tedix/db/queries/cognitive-runtime";
import {
	encodeRuntimeEventCursor,
	type TediArtifact,
	type TediConversation,
	type TediMessage,
	type TediMessageRole,
	type TediApprovalRequest as TediRuntimeApprovalRequest,
	type TediRuntimeEvent,
	type TediRuntimeHealth,
	type TediRuntimeRef,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	advanceSubmissionPhase,
	stampInputApplied,
} from "@tedix/db/queries/runtime-submissions/phase-transitions";
import { bodyExecutionUsageFromRecord } from "@tedix/api-contract/utils/body-execution-result";
import { cognitiveRuntimeContract } from "@tedix/api-contract/contracts/cognitive-runtime";
import {
	getTediById,
	updateTediRuntimeActivity,
} from "@tedix/db/queries/tedis";
import { getTrustedMcpHostAppContext } from "../../mcp-host-context";
import { implement } from "@orpc/server";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	kernelSubmissionId,
	recordTediSubmissionStarted,
	runEventKindToSubmissionOutcome,
	settleTediSubmission,
} from "../../../kernel/runtime-submission-bridge";
import { runtimeApprovalReviewSemantics } from "@tedix/api-contract/utils/approval-policy";
import { toJsonRecord } from "@tedix/db/utils/json";
import { findRuntimeEventRow } from "./event-reads";

export const PLATFORM_OPERATOR_MCP_APP_SLUG = "tedix-unified";

// ─────────────────────────────────────────────────────────────────────────────
// Inbox-wake helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify the parent Home KernelDO that a child run reached a terminal state.
 *
 * Safety invariants:
 *   - Verifies childOrgId === organizationId before any write (cross-org guard).
 *   - Writes to kernel_wake_queue then calls KernelDO.scheduleWakeAlarm via
 *     the DO binding — the DO verifies org on its side too.
 *   - All failures are fail-soft (warn + return) — a wake failure must never
 *     affect the caller's response.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inbox-wake helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify the parent Home KernelDO that a child run reached a terminal state.
 *
 * Safety invariants:
 *   - Verifies childOrgId === organizationId before any write (cross-org guard).
 *   - Writes to kernel_wake_queue then calls KernelDO.scheduleWakeAlarm via
 *     the DO binding — the DO verifies org on its side too.
 *   - All failures are fail-soft (warn + return) — a wake failure must never
 *     affect the caller's response.
 */
export async function notifyKernelChildComplete(
	context: BaseContext,
	input: {
		childRunId: string;
		childStatus: "completed" | "failed" | "canceled";
		/** Organization that owns the child run (from child's tedi row). */
		childOrganizationId: string;
		/** Organization that owns the parent conversation (from wake metadata). */
		parentOrganizationId: string;
		parentConversationId: string;
	},
): Promise<void> {
	// Cross-org guard: both sides must belong to the same org.
	if (input.childOrganizationId !== input.parentOrganizationId) {
		console.warn("[inboxWake] org mismatch — dropping cross-org wake", {
			childOrg: input.childOrganizationId,
			parentOrg: input.parentOrganizationId,
			childRunId: input.childRunId,
		});
		return;
	}
	const organizationId = input.childOrganizationId;
	const queueId = `wake:${organizationId}:${input.parentConversationId}:${input.childRunId}`;
	try {
		await enqueueKernelChildWake(context.db, {
			id: queueId,
			organizationId,
			parentConversationId: input.parentConversationId,
			childRunId: input.childRunId,
			childStatus: input.childStatus,
			queuedAt: nowIso(),
			wakeKind: "child_completed",
		});
	} catch (error) {
		console.warn(
			"[inboxWake] wake-queue insert failed",
			error instanceof Error ? error.message : error,
		);
		return;
	}
	// Call KernelDO.scheduleWakeAlarm via DO binding (fail-soft).
	try {
		const kernel = (
			context.env as unknown as {
				KERNEL?: DurableObjectNamespace<KernelDO>;
			}
		).KERNEL;
		if (!kernel) return;
		const stub = kernel.get(kernel.idFromName(organizationId));
		await stub.scheduleWakeAlarm(
			input.parentConversationId,
			input.childRunId,
			input.childStatus,
		);
	} catch (error) {
		console.warn(
			"[inboxWake] DO scheduleWakeAlarm failed",
			error instanceof Error ? error.message : error,
		);
	}
}

export async function notifyKernelChildApprovalBlock(
	context: BaseContext,
	input: {
		childRunId: string;
		childOrganizationId: string;
		parentOrganizationId: string;
		parentConversationId: string;
		approvalRequestId: string;
		delegatedTediId?: string | null;
		blocked: boolean;
	},
): Promise<void> {
	if (input.childOrganizationId !== input.parentOrganizationId) {
		console.warn("[childApproval] org mismatch — dropping mirror", {
			childOrg: input.childOrganizationId,
			parentOrg: input.parentOrganizationId,
			childRunId: input.childRunId,
		});
		return;
	}
	try {
		const kernel = (
			context.env as unknown as {
				KERNEL?: DurableObjectNamespace<KernelDO>;
			}
		).KERNEL;
		if (!kernel) return;
		const stub = kernel.get(kernel.idFromName(input.parentOrganizationId));
		if (input.blocked) {
			await stub.mirrorChildApprovalBlocked({
				parentConversationId: input.parentConversationId,
				childRunId: input.childRunId,
				approvalRequestId: input.approvalRequestId,
				delegatedTediId: input.delegatedTediId ?? null,
			});
		} else {
			await stub.clearChildApprovalBlocked({
				parentConversationId: input.parentConversationId,
				childRunId: input.childRunId,
				approvalRequestId: input.approvalRequestId,
			});
		}
	} catch (error) {
		console.warn(
			"[childApproval] KernelDO mirror failed",
			error instanceof Error ? error.message : error,
		);
	}
}

export type RuntimeEventKindDbCoversContract =
	TediRuntimeEvent["kind"] extends TediRuntimeEventInsert["kind"]
		? true
		: never;

export const runtimeEventKindDbCoversContract: RuntimeEventKindDbCoversContract = true;

void runtimeEventKindDbCoversContract;

export const cognitiveRuntimeOs = implement(
	cognitiveRuntimeContract,
).$context<BaseContext>();

export const authed = cognitiveRuntimeOs.use(withAuth);

export const serviceAuthed = cognitiveRuntimeOs.use(withServiceAuth);

export const DEFAULT_CONVERSATION_ID = "agent:main:main";

export const DEFAULT_RUNTIME_BACKEND = DEFAULT_COGNITIVE_RUNTIME_BACKEND;

export function approvalAuditActor(input: BaseContext): {
	actorId: string;
	actorType: "api_key" | "m2m" | "service" | "tedi" | "user";
} {
	if (input.user?.sub)
		return {
			actorId: input.user.sub,
			actorType: "user",
		};
	if (input.tediId)
		return {
			actorId: input.tediId,
			actorType: "tedi",
		};
	if (input.apiKey?.id)
		return {
			actorId: input.apiKey.id,
			actorType: "api_key",
		};
	if (input.serviceAccount?.clientId) {
		return {
			actorId: input.serviceAccount.clientId,
			actorType: "m2m",
		};
	}
	return {
		actorId: input.authType ?? "system",
		actorType:
			input.authType === "m2m"
				? "m2m"
				: input.authType === "apikey"
					? "api_key"
					: "service",
	};
}

export function normalizeTediConversationId(value: string | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) return DEFAULT_CONVERSATION_ID;
	if (trimmed.toLowerCase().startsWith("agent:")) {
		return canonicalizeAgentSessionKey({
			value: trimmed,
			controlIdPattern: RUNTIME_CONTROL_ID_RE,
			errorLabel: "cognitive runtime",
		});
	}
	if (trimmed.startsWith("hook:")) {
		return trimmed;
	}
	const segment =
		trimmed.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") ||
		"main";
	return `agent:main:${segment}`;
}

export function normalizeTediConversationIdForRead(value: string): string {
	const trimmed = value.trim();
	if (trimmed.toLowerCase().startsWith("agent:")) {
		return canonicalizeAgentSessionKey({
			value: trimmed,
			controlIdPattern: RUNTIME_CONTROL_ID_RE,
			errorLabel: "cognitive runtime",
		});
	}
	return trimmed;
}

/**
 * Short-TTL cache for a tedi's runtime backend. `runtime_kind` is effectively
 * stable, so a tiny TTL
 * is plenty and keeps the background cognitive-event emits off a per-write D1
 * read. An ≤5min stale label right after an upgrade is acceptable — this is an
 * observability tag, not an authorization decision.
 */

export /**
 * Short-TTL cache for a tedi's runtime backend. `runtime_kind` is effectively
 * stable, so a tiny TTL
 * is plenty and keeps the background cognitive-event emits off a per-write D1
 * read. An ≤5min stale label right after an upgrade is acceptable — this is an
 * observability tag, not an authorization decision.
 */
const runtimeBackendCache = new Map<
	string,
	{
		backend: TediRuntimeRef["backend"];
		expiresAt: number;
	}
>();

export const RUNTIME_BACKEND_TTL_MS = 5 * 60_000;

/**
 * Resolve the originating runtime backend for a tedi. All tedis run on the
 * Agent runtime (Cloudflare Agents), so this always returns "cloudflare-agents".
 * The cache is retained so call-sites are unchanged.
 */

/**
 * Resolve the originating runtime backend for a tedi. All tedis run on the
 * Agent runtime (Cloudflare Agents), so this always returns "cloudflare-agents".
 * The cache is retained so call-sites are unchanged.
 */
export async function resolveTediRuntimeBackend(
	_context: BaseContext,
	tediId: string,
): Promise<TediRuntimeRef["backend"]> {
	const now = Date.now();
	const cached = runtimeBackendCache.get(tediId);
	if (cached && cached.expiresAt > now) return cached.backend;
	const backend = "cloudflare-agents" as const;
	runtimeBackendCache.set(tediId, {
		backend,
		expiresAt: now + RUNTIME_BACKEND_TTL_MS,
	});
	return backend;
}

export function nowIso() {
	return new Date().toISOString();
}

export function nonNullRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as Record<string, unknown>;
}

export function jsonObjectArray(
	value: unknown,
): Array<Record<string, JsonValue>> | undefined {
	const parsed = JsonValueSchema.safeParse(value);
	if (!parsed.success || !Array.isArray(parsed.data)) return undefined;
	const records: Array<Record<string, JsonValue>> = [];
	for (const item of parsed.data) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			return undefined;
		}
		records.push(item);
	}
	return records;
}

export function stringFromPayload(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const WORKSTATION_EGRESS_EVENT_KINDS = new Set([
	"workstation.egress.allow",
	"workstation.egress.deny",
]);

export function isWorkstationEgressEventKind(kind: string): boolean {
	return WORKSTATION_EGRESS_EVENT_KINDS.has(kind);
}

export function numberFromPayload(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function normalizeAttachmentContent(input: {
	content: string;
	mimeType: string;
	type: string;
}): string {
	if (input.type !== "audio") return input.content;
	if (
		input.content.startsWith("data:") ||
		input.content.startsWith("blob:") ||
		input.content.startsWith("http://") ||
		input.content.startsWith("https://")
	) {
		return input.content;
	}
	return `data:${input.mimeType};base64,${input.content}`;
}

export function normalizeMessageAttachments<
	T extends
		| Array<{
				content: string;
				mimeType: string;
				type: string;
		  }>
		| undefined,
>(attachments: T): T {
	if (!attachments) return attachments;
	return attachments.map((attachment) => ({
		...attachment,
		content: normalizeAttachmentContent(attachment),
	})) as T;
}

export async function requireTediAccess(context: BaseContext, tediId: string) {
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
	const mcpHostApp = getTrustedMcpHostAppContext(context);
	const platformPrincipal =
		isPlatformPrincipal(context) ||
		mcpHostApp.appSlug === PLATFORM_OPERATOR_MCP_APP_SLUG;
	if (context.tediId && context.tediId !== tediId && !platformPrincipal) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (
		context.organizationId &&
		tedi.organizationId !== context.organizationId &&
		!platformPrincipal
	) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (!context.organizationId && !context.tediId && !platformPrincipal) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	return tedi;
}

export function normalizeRuntimeRef(row: {
	runtimeBackend: string;
	runtimeExternalId?: string | null;
	runtimeExternalUrl?: string | null;
	runtimeMetadata?: Record<string, unknown> | null;
}): TediRuntimeRef {
	return {
		backend: row.runtimeBackend as TediRuntimeRef["backend"],
		externalId: row.runtimeExternalId ?? undefined,
		externalUrl: row.runtimeExternalUrl ?? undefined,
		metadata: nonNullRecord(row.runtimeMetadata),
	};
}

export function normalizeRuntimeEvent(
	row: TediRuntimeEventRow,
): TediRuntimeEvent {
	const payload = nonNullRecord(row.payload);
	// Promote the canonical token usage out of the raw payload JSON into the
	// typed `usage` field. Writers (isolate step.completed / kernel turn events)
	// stash usage under `payload.usage`; the projector applies the null-absent
	// invariant and returns undefined when the event carries no usage, so the
	// field stays optional and no storage migration is needed.
	const usage = bodyExecutionUsageFromRecord(payload?.usage) ?? undefined;
	return {
		id: row.id,
		tediId: row.tediId,
		kind: row.kind,
		conversationId: row.conversationId ?? undefined,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		toolCallId: row.toolCallId ?? undefined,
		approvalRequestId: row.approvalRequestId ?? undefined,
		artifactId: row.artifactId ?? undefined,
		sequence: row.sequence ?? undefined,
		delta: row.delta ?? undefined,
		payload,
		...(usage
			? {
					usage,
				}
			: {}),
		runtime: normalizeRuntimeRef(row),
		createdAt: row.createdAt,
	};
}

export function normalizeApprovalStatus(
	status: string,
): TediRuntimeApprovalRequest["status"] {
	return status === "cancelled"
		? "canceled"
		: (status as TediRuntimeApprovalRequest["status"]);
}

export function normalizeApprovalRequest(
	row: TediApprovalRequestRow,
): TediRuntimeApprovalRequest {
	const payload = nonNullRecord(row.payload) ?? {};
	const title =
		stringFromPayload(payload.title) ??
		stringFromPayload(payload.name) ??
		row.actionType;
	return {
		id: row.id,
		tediId: row.tediId,
		actionType: row.actionType,
		title,
		description: row.description,
		payload,
		status: normalizeApprovalStatus(row.status),
		requestedBy: stringFromPayload(payload.requestedBy) ?? null,
		resolvedBy: row.resolvedBy,
		resolution: row.resolution,
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
		resolvedAt: row.resolvedAt,
		metadata: {
			source: "tedi_approval_requests",
			workflowId: row.workflowId,
			orgId: row.orgId,
			review: runtimeApprovalReviewSemantics({
				id: row.id,
				tediId: row.tediId,
				actionType: row.actionType,
				description: row.description,
				payload,
				status: row.status,
				expiresAt: row.expiresAt,
				workflowId: row.workflowId,
			}),
		},
	};
}

export function isTrustedRuntimeArtifactCaller(
	context: BaseContext,
	tediId: string,
): boolean {
	return (
		context.authType === "service-binding" &&
		context.headers?.get("X-Tedix-Caller") === "brain-bridge" &&
		context.headers?.get("X-Tedix-Caller-Source") === "http-platform-client" &&
		!context.headers?.get("X-Tedix-Mcp-Tool-Id") &&
		(context.tediId === tediId ||
			context.headers?.get("X-Tedix-Tedi-Id") === tediId)
	);
}

export function normalizeArtifact(
	row: TediArtifactRow,
	options: { exposePrivateRuntimeLocation?: boolean } = {},
): TediArtifact {
	const privateRuntime = row.accessClassification === "runtime_private";
	const hidePrivate = privateRuntime && !options.exposePrivateRuntimeLocation;
	return {
		id: row.id,
		tediId: row.tediId,
		conversationId: row.conversationId ?? undefined,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		kind: row.kind,
		name: row.name,
		mimeType: row.mimeType ?? null,
		uri: hidePrivate ? undefined : (row.uri ?? undefined),
		sizeBytes: row.sizeBytes ?? null,
		metadata: privateRuntime ? undefined : nonNullRecord(row.metadata),
		accessClassification: row.accessClassification,
		createdAt: row.createdAt,
	};
}

export async function mappedDispatchRunIds(
	context: BaseContext,
	input: {
		tediId: string;
		runId?: string;
	},
): Promise<string[]> {
	if (!input.runId) return [];
	const mappedRunId = await getMappedDispatchRunId(context.db, {
		tediId: input.tediId,
		idempotencyKey: input.runId,
	});
	if (!mappedRunId || mappedRunId === input.runId) return [];
	return [mappedRunId];
}

export function nextCursor<
	T extends {
		createdAt: string;
	},
>(rows: T[], limit: number): string | null {
	return rows.length === limit
		? (rows[rows.length - 1]?.createdAt ?? null)
		: null;
}

export function nextRuntimeEventCursor(
	rows: Array<Pick<TediRuntimeEventRow, "createdAt" | "id">>,
	limit: number,
): string | null {
	const last = rows.length === limit ? rows[rows.length - 1] : undefined;
	return last
		? encodeRuntimeEventCursor({ createdAt: last.createdAt, id: last.id })
		: null;
}

export function readPayloadText(
	payload: Record<string, unknown> | undefined,
): string {
	return (
		stringFromPayload(payload?.content) ??
		stringFromPayload(payload?.text) ??
		stringFromPayload(nonNullRecord(payload?.message)?.content) ??
		""
	);
}

export function readPayloadAttachments(
	payload: Record<string, unknown> | undefined,
): TediMessage["attachments"] {
	if (!Array.isArray(payload?.attachments)) return undefined;
	const attachments: NonNullable<TediMessage["attachments"]> =
		payload.attachments.flatMap((attachment) => {
			const record = nonNullRecord(attachment);
			const content = stringFromPayload(record?.content);
			const durationMs = numberFromPayload(record?.durationMs);
			const fileName = stringFromPayload(record?.fileName);
			const mimeType = stringFromPayload(record?.mimeType);
			const size = numberFromPayload(record?.size);
			const type = stringFromPayload(record?.type);
			if (
				!content ||
				!fileName ||
				!mimeType ||
				(type !== "audio" && type !== "file" && type !== "image")
			) {
				return [];
			}
			return [
				{
					content: normalizeAttachmentContent({
						content,
						mimeType,
						type,
					}),
					...(durationMs && durationMs > 0
						? {
								durationMs,
							}
						: {}),
					fileName,
					mimeType,
					...(size !== undefined && size >= 0
						? {
								size,
							}
						: {}),
					type,
				},
			];
		});
	return attachments.length > 0 ? attachments : undefined;
}

export function readPayloadRole(
	payload: Record<string, unknown> | undefined,
	kind: string,
): TediMessageRole {
	const role = stringFromPayload(payload?.role);
	if (
		role === "system" ||
		role === "user" ||
		role === "assistant" ||
		role === "tool" ||
		role === "runtime"
	) {
		return role;
	}
	return kind === "message.received" ? "user" : "assistant";
}

export function inferConversationChannel(
	conversationId: string,
): string | null {
	if (conversationId.startsWith("agent:")) return "internal";
	const colonIdx = conversationId.indexOf(":");
	if (colonIdx > 0) return conversationId.slice(0, colonIdx);
	return null;
}

export function conversationMatchesInput(
	conversation: Pick<TediConversation, "id" | "title" | "channel">,
	input: {
		channel?: string;
		search?: string;
	},
): boolean {
	if (input.channel && conversation.channel !== input.channel) return false;
	if (input.search) {
		const q = input.search.toLowerCase();
		const title = conversation.title ?? "";
		return (
			conversation.id.toLowerCase().includes(q) ||
			title.toLowerCase().includes(q) ||
			(conversation.channel?.toLowerCase().includes(q) ?? false)
		);
	}
	return true;
}

/**
 * Health for an ISOLATE tedi. Isolate tedis run as serverless Cloudflare Workers
 * + Durable Objects — they have NO long-lived container and therefore no
 * container heartbeat. The container-shaped {@link healthForTedi} falls through
 * to "degraded" for them (`runtimeStatus` is null), which is wrong: an active
 * isolate tedi is HEALTHY — the platform can always route a request to its DO.
 * Health derives from the tedi's lifecycle `status`, not a container state.
 */

/**
 * Health for an ISOLATE tedi. Isolate tedis run as serverless Cloudflare Workers
 * + Durable Objects — they have NO long-lived container and therefore no
 * container heartbeat. The container-shaped {@link healthForTedi} falls through
 * to "degraded" for them (`runtimeStatus` is null), which is wrong: an active
 * isolate tedi is HEALTHY — the platform can always route a request to its DO.
 * Health derives from the tedi's lifecycle `status`, not a container state.
 */
export function healthForIsolateTedi(
	tedi:
		| null
		| undefined
		| {
				status: string | null;
				runtimeState: string | null;
		  },
): TediRuntimeHealth {
	if (!tedi) return "unreachable";
	if (tedi.status === "error") return "degraded";
	if (tedi.status === "provisioning") return "starting";
	if (tedi.status === "paused" || tedi.runtimeState === "archived")
		return "stopped";
	return "healthy";
}

/**
 * Insert a runtime event into the canonical `tedi_runtime_events` ledger.
 *
 * Exported so cognitive write sites in OTHER routers (rationale, skill, memory)
 * can bridge their writes onto the runtime spine — the cognitive-event
 * bridge. Idempotent on the deterministic
 * `runtimeEventId()` via `onConflictDoNothing`, so re-emits are safe.
 */

/**
 * Insert a runtime event into the canonical `tedi_runtime_events` ledger.
 *
 * Exported so cognitive write sites in OTHER routers (rationale, skill, memory)
 * can bridge their writes onto the runtime spine — the cognitive-event
 * bridge. Idempotent on the deterministic
 * `runtimeEventId()` via `onConflictDoNothing`, so re-emits are safe.
 */
export async function insertRuntimeEvent(
	context: BaseContext,
	input: {
		id?: string;
		organizationId: string;
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
		runtimeBackend?: TediRuntimeRef["backend"];
		runtimeExternalId?: string;
		runtimeExternalUrl?: string;
		runtimeMetadata?: Record<string, unknown>;
		createdAt?: string;
	},
): Promise<TediRuntimeEvent> {
	const createdAt = input.createdAt ?? nowIso();
	const runtimeBackend = input.runtimeBackend ?? DEFAULT_RUNTIME_BACKEND;
	// Dedup guard: only one `message.completed` per (tediId, runId) is allowed
	// in the canonical ledger. Two emission paths can both reach this point —
	// the `recordEvent` handler when a runtime posts a real terminal frame, and
	// `promoteLatestDeltaToCompletedMessage` when `run.completed` arrives
	// before a real `message.completed`. Both have their own pre-check, but a
	// race (concurrent writes, or any future caller) can still slip past.
	// Catch it here, at the single insert boundary, so the ledger never grows
	// duplicate `message.completed` rows that corrupt analytics/replay/audit.
	if (input.kind === "message.completed" && input.runId) {
		const existing = await findRuntimeEventRow(context, {
			conversationId: input.conversationId,
			kind: "message.completed",
			runId: input.runId,
			tediId: input.tediId,
		});
		if (existing) return normalizeRuntimeEvent(existing);
	}
	// Dedup guard: only one row per (tediId, runId, kind) is allowed for the run
	// lifecycle kinds. Independent writers can post lifecycle events for the
	// same run with DIFFERENT canonical event ids (so the `onConflictDoNothing`
	// id-uniqueness gate never fires):
	//   1. The API enqueue path pre-records `run.started` under the caller's
	//      stable dispatch id (source: os.chat / MCP).
	//   2. A resident runtime event bridge posts lifecycle events with id prefix
	//      `runtime-agent:` (source:
	//      tedix-context-agent-event-subscription).
	//   3. Tedix OS-browser sessions mirror gateway WS frames through the
	//      `/api/chat/runtime-event` action with id prefix `runtime:event:agent:`
	//      (Track G's skip-list only covers `recordGatewayRuntimeEvent`, NOT the
	//      Tedix OS-mirror path).
	// Skip-listing the gateway-ws-proxy path alone isn't enough because the IDs
	// differ across writers and id-uniqueness can't catch them. Catch at the
	// single insert boundary so the ledger holds exactly one row per (tedi, run,
	// lifecycle-kind), regardless of how many writers race.
	if (
		input.runId &&
		(input.kind === "run.started" ||
			input.kind === "run.completed" ||
			input.kind === "run.failed" ||
			input.kind === "run.canceled")
	) {
		const existing = await findRuntimeEventRow(context, {
			conversationId: input.conversationId,
			kind: input.kind,
			runId: input.runId,
			tediId: input.tediId,
		});
		if (existing) return normalizeRuntimeEvent(existing);
	}
	const event = buildTediRuntimeEvent({
		id: input.id,
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
		runtimeBackend,
		runtimeExternalId: input.runtimeExternalId,
		runtimeExternalUrl: input.runtimeExternalUrl,
		runtimeMetadata: input.runtimeMetadata,
		createdAt,
	});
	const inserted = await insertTediRuntimeEvent(context.db, {
		id: event.id,
		organizationId: input.organizationId,
		tediId: event.tediId,
		kind: event.kind,
		conversationId: event.conversationId,
		runId: event.runId,
		messageId: event.messageId,
		toolCallId: event.toolCallId,
		approvalRequestId: event.approvalRequestId,
		artifactId: event.artifactId,
		sequence: event.sequence,
		delta: event.delta,
		payload:
			event.payload === undefined ? undefined : toJsonRecord(event.payload),
		runtimeBackend: event.runtime?.backend ?? runtimeBackend,
		runtimeExternalId: event.runtime?.externalId,
		runtimeExternalUrl: event.runtime?.externalUrl,
		runtimeMetadata:
			event.runtime?.metadata === undefined
				? undefined
				: toJsonRecord(event.runtime.metadata),
		traceId:
			typeof input.runtimeMetadata?.traceId === "string"
				? input.runtimeMetadata.traceId
				: undefined,
		createdAt: event.createdAt,
	});
	if (inserted) {
		await updateTediRuntimeActivity(context.db, input.tediId, createdAt, {
			heartbeat: input.kind === "runtime.health_changed",
		});
		// Durable submission ledger (tedi subject): admit on run.started, settle
		// exactly-once on a terminal run event. Fires once per lifecycle kind (the
		// dedup guards above return before a re-insert reaches here). Fail-soft.
		if (input.runId) {
			if (input.kind === "run.started") {
				await recordTediSubmissionStarted(context.db, {
					tediId: input.tediId,
					runId: input.runId,
					organizationId: input.organizationId,
					conversationId: input.conversationId,
					runtimeBackend,
				});
				// Recovery-hardening: stamp inputAppliedAt and advance phase to
				// "provider_started" exactly once (both are CAS-guarded; re-sends are
				// inert). Fail-soft — never throw into or block the event insert.
				try {
					const submissionId = kernelSubmissionId(input.runId);
					await advanceSubmissionPhase(context.db, {
						submissionId,
						organizationId: input.organizationId,
						phase: "provider_started",
					});
					await stampInputApplied(context.db, {
						submissionId,
						organizationId: input.organizationId,
						appliedAtIso: createdAt,
					});
				} catch (phaseErr) {
					console.warn(
						"[tedi] phase/stamp failed on run.started",
						input.runId,
						phaseErr instanceof Error ? phaseErr.message : String(phaseErr),
					);
				}
			} else {
				// Recovery-hardening: advance phase to "tool_request_recorded" on the
				// first tool or step event (monotonic CAS — no-op if already at a higher
				// phase). Fail-soft.
				if (
					input.kind === "tool.started" ||
					input.kind === "tool.completed" ||
					input.kind === "step.completed"
				) {
					try {
						await advanceSubmissionPhase(context.db, {
							submissionId: kernelSubmissionId(input.runId),
							organizationId: input.organizationId,
							phase: "tool_request_recorded",
						});
					} catch (phaseErr) {
						console.warn(
							"[tedi] phase advance failed",
							input.runId,
							phaseErr instanceof Error ? phaseErr.message : String(phaseErr),
						);
					}
				}
				const tediOutcome = runEventKindToSubmissionOutcome(input.kind);
				if (tediOutcome) {
					await settleTediSubmission(context.db, {
						runId: input.runId,
						organizationId: input.organizationId,
						outcome: tediOutcome,
					});
				}
			}
		}
		return normalizeRuntimeEvent(inserted);
	}
	const existing = await getTediRuntimeEventById(context.db, event.id);
	if (existing) return normalizeRuntimeEvent(existing);
	throw createError(
		ErrorCodes.INTERNAL_SERVER_ERROR,
		"Runtime event insert was ignored and no existing event was found",
	);
}

export function workstationFromEgressEvent(event: TediRuntimeEvent) {
	const payload = nonNullRecord(event.payload) ?? {};
	const runtimeMetadata = nonNullRecord(event.runtime?.metadata) ?? {};
	const profileId =
		stringFromPayload(payload.profileId) ??
		stringFromPayload(runtimeMetadata.profileId);
	const workstationId =
		stringFromPayload(payload.workstationId) ??
		stringFromPayload(runtimeMetadata.workstationId) ??
		stringFromPayload(event.runtime?.externalId);
	if (profileId !== "general" || !workstationId) return null;
	return {
		profileId: "general" as const,
		workstationId,
		leaseId:
			stringFromPayload(payload.leaseId) ??
			stringFromPayload(runtimeMetadata.leaseId) ??
			null,
		sessionId:
			stringFromPayload(payload.sessionId) ??
			stringFromPayload(runtimeMetadata.sessionId) ??
			null,
		participantIds: [event.tediId],
	};
}
