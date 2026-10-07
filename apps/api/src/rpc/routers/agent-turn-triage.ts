/**
 * Agent-turn urgency triage.
 *
 * `triage` scores an agent's message to its operator against the caller's
 * triage questions with a Workers AI Clef decision model; `labelReply`
 * classifies an operator reply into a fixed reply vocabulary. Neither stores
 * anything. A model failure or timeout degrades to `status: "unavailable"`
 * (urgency `later`) instead of an error, so a caller can always proceed.
 *
 * The question set is configuration: a stored `user_configs` row in namespace
 * `work.turn-triage` keyed by the credential-resolved organization (the same
 * per-user-per-tenant shape and revision CAS as `user-settings.ts`) wins, and a
 * missing or unparseable row falls back to the versioned default asset
 * `agent-turn-triage-defaults.json`.
 *
 * Reply drafting (`requestReplyDraft`, `proposeReplyDraft`,
 * `getReplyDraftAcceptance`): the target user of a quiet (`later`, no urgent
 * labels) decision-capture question may ask the policy's drafting tedi for a
 * reply proposal. The request starts one `tedi_turn` per attempt (dispatched
 * directly, the automation queue as fallback) with the board context inlined,
 * so the tedi's only tool call stores its proposal with `proposeReplyDraft`
 * (a failed attempt may be re-requested, bounded), and the
 * server decides its delivery once ({@link decideReplyDraftDelivery}):
 * `review` drafts wait for the user to accept, edit, or replace them (cited in
 * response metadata, which is what acceptance is measured from); `auto`
 * drafts may be sent without review under the policy's `autoSend` guardrails
 * and its Clef `deliveryGate` (`services/reply-draft-gate.ts`).
 * The drafting prompt is the versioned `replyDraft` block of the defaults
 * asset.
 */

import { ORPCError, implement } from "@orpc/server";
import { agentTurnTriageContract } from "@tedix/api-contract/contracts/agent-turn-triage";
import {
	AGENT_REPLY_LABELS,
	type AgentReplyDeliveryGatePolicy,
	type AgentReplyDeliveryGateResult,
	type AgentReplyDraftDelivery,
	type AgentReplyDraftIneligibleReason,
	type AgentReplyLabel,
	type AgentTurnTriagePolicy,
	type AgentTurnTriagePolicyState,
	AgentTurnTriagePolicySchema,
	type TriageResult,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import {
	type AutomationEvent,
	AutomationEventSchema,
} from "@tedix/api-contract/schemas/automation-events";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { getSkillEntryForMcp } from "@tedix/db/queries/cognitive/skill-crud";
import { getChatDispatchMappingByIdempotencyKey } from "@tedix/db/queries/kernel-runtime-events";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getUserConfig, putUserConfig } from "@tedix/db/queries/user-configs";
import { listWorkAgentSessions } from "@tedix/db/queries/work-agent-sessions";
import {
	getWorkItemById,
	listWorkItems,
} from "@tedix/db/queries/work-items/crud";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import {
	countConsecutiveAutoReplies,
	getLatestReplyDraft,
	getReplyDraftAcceptance,
	insertReplyDraft,
} from "@tedix/db/queries/work-items/reply-drafts";
import type { WorkItem } from "@tedix/db/schema/work-items";
import * as z from "zod";
import { type ClefQuestion, runClef } from "../../lib/clef";
import { buildReplyDraftExamplesBlock } from "../../services/reply-draft-examples";
import { evaluateReplyDraftGate } from "../../services/reply-draft-gate";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import defaultsAsset from "./agent-turn-triage-defaults.json";
import { verifiedActiveWorkActor } from "./work-items-principal";
import { rethrowWorkControlError } from "./work-items/policy-helpers";

const os = implement(agentTurnTriageContract).$context<BaseContext>();
const readOs = os.use(withAuth).use(AUTHZ.messagingRead);
const writeOs = os
	.use(withAuth)
	.use(withAuthorization("tedis:update", "mcp:messaging.write"));
const draftWriteOs = os.use(withAuth).use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Reply drafts are bound to one question: only its target user may request one and only the target's configured drafting tedi may propose one; handlers revalidate the active actor and the DB insert guard rechecks question, org, and tedi",
		},
		"mcp:messaging.write",
	),
);

export const AGENT_TURN_TRIAGE_NAMESPACE = "work.turn-triage";

const DefaultsAssetSchema = z.object({
	assetVersion: z.number().int().min(1),
	policy: AgentTurnTriagePolicySchema,
	replyLabel: z.object({
		instructions: z.string().min(1),
		criteria: z.record(z.enum(AGENT_REPLY_LABELS), z.string().min(1)),
	}),
	replyDraft: z.object({
		promptVersion: z.number().int().min(1),
		lines: z.array(z.string()).min(1),
	}),
});

/**
 * Parsed once per isolate (the router module is lazy). A malformed asset is a
 * build defect and must fail loudly rather than triage with a partial set.
 */
const DEFAULTS = DefaultsAssetSchema.parse(defaultsAsset);
for (const label of AGENT_REPLY_LABELS) {
	if (!DEFAULTS.replyLabel.criteria[label]) {
		throw new Error(`agent-turn-triage defaults: missing reply class ${label}`);
	}
}
export const DEFAULT_AGENT_TURN_TRIAGE_POLICY: AgentTurnTriagePolicy =
	DEFAULTS.policy;
if (!DEFAULTS.policy.deliveryGate) {
	throw new Error("agent-turn-triage defaults: missing policy.deliveryGate");
}
/** The gate for stored policies that predate `deliveryGate`. */
export const DEFAULT_AGENT_REPLY_DELIVERY_GATE: AgentReplyDeliveryGatePolicy =
	DEFAULTS.policy.deliveryGate;

/**
 * The user who owns the policy row: the session's Tedix user id, else the
 * verified active member behind a gateway credential (the same identity the
 * draft tools use). A machine principal without a user identity has none.
 */
async function policyUserId(
	context: BaseContext,
	organizationId: string,
): Promise<string | null> {
	if (context.userId) return context.userId;
	try {
		const actor = await verifiedActiveWorkActor(context, organizationId);
		return actor.type === "user" ? actor.id : null;
	} catch {
		return null;
	}
}

async function readPolicyState(
	context: BaseContext,
	organizationId: string,
): Promise<AgentTurnTriagePolicyState> {
	return readPolicyStateFor(
		context,
		await policyUserId(context, organizationId),
		organizationId,
	);
}

/** The stored policy of one user in one organization, or the defaults. */
async function readPolicyStateFor(
	context: BaseContext,
	userId: string | null,
	organizationId: string,
): Promise<AgentTurnTriagePolicyState> {
	const row = userId
		? await getUserConfig(context.db, {
				userId,
				namespace: AGENT_TURN_TRIAGE_NAMESPACE,
				key: organizationId,
			})
		: null;
	const parsed = row ? AgentTurnTriagePolicySchema.safeParse(row.value) : null;
	if (!row || !parsed?.success) {
		return {
			policy: DEFAULT_AGENT_TURN_TRIAGE_POLICY,
			source: "default",
			revision: row?.revision ?? 0,
			updatedAt: row?.updatedAt ?? null,
		};
	}
	return {
		policy: parsed.data,
		source: "stored",
		revision: row.revision,
		updatedAt: row.updatedAt ?? null,
	};
}

/** Pure scoring step, exported for tests: urgency from labels + thresholds. */
export function scoreTriage(
	policy: AgentTurnTriagePolicy,
	labels: Record<string, number>,
): Pick<TriageResult, "urgency" | "urgentLabels"> {
	const urgentLabels = policy.questions
		.filter((question) => (labels[question.id] ?? 0) >= question.urgentWhen.gte)
		.map((question) => question.id);
	return { urgency: urgentLabels.length > 0 ? "now" : "later", urgentLabels };
}

const triage = readOs.triage.handler(async ({ input, context }) => {
	const organizationId = requireOrgId(context);
	const { policy } = await readPolicyState(context, organizationId);
	const unavailable = (latencyMs: number): TriageResult => ({
		status: "unavailable",
		urgency: "later",
		labels: {},
		urgentLabels: [],
		model: policy.model,
		policyVersion: policy.version,
		latencyMs,
	});
	if (!policy.enabled) return unavailable(0);

	const questions: Record<string, ClefQuestion> = {};
	for (const question of policy.questions) {
		questions[question.id] = {
			type: "noul",
			instructions: question.instructions,
		};
	}
	const result = await runClef(context.env, {
		modelId: policy.model,
		state: { agent_message: input.text },
		questions,
		surface: "agent-turn-triage",
	});
	if (!result.ok) return unavailable(result.latencyMs);

	const labels: Record<string, number> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		if (answer.type === "noul") labels[id] = answer.noul;
	}
	return {
		status: "ok",
		...scoreTriage(policy, labels),
		labels,
		model: policy.model,
		policyVersion: policy.version,
		latencyMs: result.latencyMs,
	};
});

const labelReply = readOs.labelReply.handler(async ({ input, context }) => {
	const organizationId = requireOrgId(context);
	const { policy } = await readPolicyState(context, organizationId);
	const result = await runClef(context.env, {
		modelId: policy.model,
		state: {
			agent_last_message: input.turnText,
			operator_reply: input.replyText,
		},
		questions: {
			reply_class: {
				type: "choice",
				instructions: DEFAULTS.replyLabel.instructions,
				criteria: DEFAULTS.replyLabel.criteria,
			},
		},
		surface: "agent-reply-label",
	});
	const answer = result.ok ? result.answers.reply_class : undefined;
	if (!answer || answer.type !== "choice") {
		return {
			status: "unavailable" as const,
			label: null,
			p: null,
			model: policy.model,
		};
	}
	return {
		status: "ok" as const,
		label: answer.choice as AgentReplyLabel,
		p: answer.probabilities[answer.choice] ?? answer.confidence,
		model: policy.model,
	};
});

const getPolicy = readOs.getPolicy.handler(async ({ context }) =>
	readPolicyState(context, requireOrgId(context)),
);

const updatePolicy = writeOs.updatePolicy.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const userId = await policyUserId(context, organizationId);
		if (!userId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Triage policy belongs to a Tedix user identity; this credential resolves none",
			);
		}
		const current = await readPolicyState(context, organizationId);
		const policy: AgentTurnTriagePolicy = {
			...input.policy,
			version: current.policy.version + 1,
		};
		const result = await putUserConfig(context.db, {
			userId,
			namespace: AGENT_TURN_TRIAGE_NAMESPACE,
			key: organizationId,
			value: policy as unknown as Record<string, JsonValue>,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) {
			throw new ORPCError("CONFLICT", {
				message:
					"Triage policy revision compare-and-swap lost against a concurrent write",
				data: {
					expectedRevision: input.expectedRevision,
					currentRevision: result.currentRevision,
				},
			});
		}
		return {
			policy,
			source: "stored" as const,
			revision: result.row.revision,
			updatedAt: result.row.updatedAt ?? null,
		};
	},
);

export const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
export const REPLY_DRAFT_PROMPT_VERSION = DEFAULTS.replyDraft.promptVersion;
const REPLY_DRAFT_SOURCE = "reply-draft";
const PROMPT_TEXT_LIMIT = 8_000;
const PEER_SESSION_LIMIT = 10;
const BOARD_ITEM_LIMIT = 10;
const SKILL_TEXT_LIMIT = 6_000;
/** Drafting turns per question: the first plus two re-requests. */
export const REPLY_DRAFT_MAX_ATTEMPTS = 3;
/** A re-request may start a new attempt once the previous dispatch is this old. */
export const REPLY_DRAFT_RETRY_AFTER_MS = 2 * 60_000;

type InteractionRow = NonNullable<
	Awaited<ReturnType<typeof getWorkInteraction>>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why a question cannot be drafted, from the question alone. Mirrors the
 * migration's insert guard: a draft is only ever proposed for an open,
 * user-targeted decision-capture question whose triage succeeded as `later`
 * with no urgent labels. Untriaged or unavailable triage is never drafted.
 */
export function replyDraftQuestionIneligibility(
	row: InteractionRow,
	observedAt: string,
): AgentReplyDraftIneligibleReason | null {
	if (
		row.status !== "open" ||
		(row.expiresAt !== null && row.expiresAt <= observedAt)
	)
		return "not_open";
	if (row.kind !== "question" || row.targetType !== "user")
		return "not_question";
	const metadata = row.metadata as Record<string, unknown>;
	if (metadata.schema !== DECISION_CAPTURE_SCHEMA)
		return "not_decision_capture";
	const triage = metadata.triage;
	if (!isRecord(triage) || triage.status !== "ok") return "untriaged";
	if (triage.urgency !== "later") return "urgent";
	if (
		triage.urgentLabels !== undefined &&
		(!Array.isArray(triage.urgentLabels) || triage.urgentLabels.length > 0)
	)
		return "urgent";
	return null;
}

async function activeDraftingTediId(
	context: BaseContext,
	policy: AgentTurnTriagePolicy,
	organizationId: string,
): Promise<string | null> {
	const tediId = policy.drafting.tediId;
	if (!tediId) return null;
	const tedi = await getTediByIdForOrganization(
		context.db,
		tediId,
		organizationId,
	);
	return tedi && tedi.status === "active" && tedi.retiredAt === null
		? tedi.id
		: null;
}

function oneLine(value: string, limit: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

type BoardItem = Pick<
	WorkItem,
	"id" | "title" | "description" | "disposition" | "priority" | "projectId"
>;

/**
 * The board context a drafting turn needs, read server-side so the tedi makes
 * no reads of its own: the linked Work Item and up to
 * {@link BOARD_ITEM_LIMIT} accepted Work Items of the question's project.
 */
export function renderReplyDraftBoard(params: {
	linked: BoardItem | null;
	projectId: string | null;
	accepted: readonly BoardItem[];
}): string {
	const lines: string[] = [];
	const { linked } = params;
	if (linked) {
		lines.push(
			`Linked Work Item ${linked.id} [${linked.disposition}, ${linked.priority}]: ${oneLine(linked.title, 200)}`,
		);
		if (linked.description?.trim()) {
			lines.push(`  ${oneLine(linked.description, 600)}`);
		}
	} else {
		lines.push("Linked Work Item: none");
	}
	if (!params.projectId) {
		lines.push("Accepted project Work Items: no project");
		return lines.join("\n");
	}
	const accepted = params.accepted
		.filter((item) => item.id !== linked?.id)
		.slice(0, BOARD_ITEM_LIMIT);
	lines.push(`Accepted Work Items of project ${params.projectId}:`);
	if (accepted.length === 0) lines.push("- none");
	for (const item of accepted) {
		lines.push(`- ${item.id} [${item.priority}]: ${oneLine(item.title, 160)}`);
	}
	return lines.join("\n");
}

/** Render the versioned drafting prompt from the defaults asset. */
export function renderReplyDraftPrompt(params: {
	request: Pick<
		InteractionRow,
		"id" | "subject" | "prompt" | "workItemId" | "projectId"
	>;
	sessions: ReadonlyArray<{ label: string; state: string; summary: string }>;
	skillSlug?: string;
	/** The drafting skill's body, read server-side; absent when unavailable. */
	skillContent?: string | null;
	/** The rendered board block ({@link renderReplyDraftBoard}). */
	board?: string;
	turnTypeChoices?: readonly string[];
	/** The user's past replies block; placed at `{{examples}}`, else after the sessions. */
	examples?: string;
}): string {
	const prompt =
		params.request.prompt.length > PROMPT_TEXT_LIMIT
			? `${params.request.prompt.slice(0, PROMPT_TEXT_LIMIT)}\n[truncated]`
			: params.request.prompt;
	const sessions =
		params.sessions.length > 0
			? params.sessions
					.slice(0, PEER_SESSION_LIMIT)
					.map(
						(session) =>
							`- ${oneLine(session.label || "(unlabelled)", 80)} [${session.state}]: ${oneLine(session.summary, 240)}`,
					)
					.join("\n")
			: "- none reported";
	const values: Record<string, string> = {
		requestId: params.request.id,
		subject: oneLine(params.request.subject, 300),
		workItemId: params.request.workItemId ?? "none",
		projectId: params.request.projectId ?? "none",
		prompt,
		sessions,
		board: params.board?.trim() || "unavailable; draft from the question alone",
		skill: renderSkillBlock(params.skillSlug, params.skillContent),
		turnTypeChoices: params.turnTypeChoices?.length
			? params.turnTypeChoices.join(", ")
			: "a short label you choose, such as approval, continue, status, correction",
	};
	const examples = params.examples ?? "";
	const lines = DEFAULTS.replyDraft.lines;
	const placed = lines.some((line) => line.includes("{{examples}}"));
	const anchor = placed
		? -1
		: lines.findIndex((line) => line.includes("{{sessions}}"));
	return lines
		.flatMap((line, index) => {
			const rendered = line.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
				key === "examples"
					? examples
					: key in values
						? (values[key] as string)
						: match,
			);
			return index === anchor && examples
				? [rendered, "", examples]
				: [rendered];
		})
		.concat(anchor === -1 && !placed && examples ? ["", examples] : [])
		.join("\n");
}

function renderSkillBlock(
	slug: string | undefined,
	content: string | null | undefined,
): string {
	if (!slug) return "(No drafting skill is configured.)";
	const body = content?.trim();
	if (!body) {
		return `(The drafting skill "${slug}" is unavailable; use the style below.)`;
	}
	const bounded =
		body.length > SKILL_TEXT_LIMIT
			? `${body.slice(0, SKILL_TEXT_LIMIT)}\n[truncated]`
			: body;
	return `Drafting skill "${slug}"; follow it where it differs from the style below:\n<<<\n${bounded}\n>>>`;
}

/** The board block for a drafting prompt; a read failure drafts without it. */
async function replyDraftBoard(
	context: BaseContext,
	orgId: string,
	request: InteractionRow,
): Promise<string> {
	try {
		const listAccepted = (projectId: string | null) =>
			projectId
				? listWorkItems(context.db, {
						orgId,
						projectId,
						disposition: "accepted",
						limit: BOARD_ITEM_LIMIT + 1,
					})
				: Promise.resolve([]);
		const readLinked = request.workItemId
			? getWorkItemById(context.db, request.workItemId, orgId)
			: Promise.resolve(null);
		// The question's own project lets both reads run at once; otherwise the
		// project comes from the linked Work Item.
		const [linked, known] = await Promise.all([
			readLinked,
			listAccepted(request.projectId),
		]);
		const projectId = request.projectId ?? linked?.projectId ?? null;
		const accepted = request.projectId ? known : await listAccepted(projectId);
		return renderReplyDraftBoard({ linked, projectId, accepted });
	} catch (error) {
		console.warn("reply-draft board unavailable", {
			requestId: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return "";
	}
}

/** The drafting skill's body as the drafting tedi may read it, else null. */
async function replyDraftSkill(
	context: BaseContext,
	orgId: string,
	params: { slug: string | undefined; tediId: string },
): Promise<string | null> {
	if (!params.slug) return null;
	try {
		const entry = await getSkillEntryForMcp(context.db, orgId, {
			slug: params.slug,
			tediId: params.tediId,
		});
		return entry && entry.lifecycleState !== "archived" ? entry.content : null;
	} catch (error) {
		console.warn("reply-draft skill unavailable", {
			slug: params.slug,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** Dispatch key of a question's drafting attempt; attempt 1 keeps the original key. */
export function replyDraftDispatchKey(requestId: string, attempt: number) {
	return attempt <= 1
		? `reply-draft:${requestId}`
		: `reply-draft:${requestId}:${attempt}`;
}

/** D1 `CURRENT_TIMESTAMP` has no zone; it is UTC. */
function parseLedgerTime(value: string): number {
	const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
	return Date.parse(iso);
}

/**
 * What a draft request does next, from the question's earlier dispatches
 * (`createdAt` of each attempt's dispatch-ledger row, null when absent) and
 * whether a draft exists. An attempt without a ledger row was never
 * dispatched, so it is (re)sent under the same key; the runtime dedupes a
 * key it already ran. A recent dispatch is in flight; an old one that left no
 * draft failed, so the next attempt starts, up to
 * {@link REPLY_DRAFT_MAX_ATTEMPTS}.
 */
export function nextReplyDraftAttempt(params: {
	hasDraft: boolean;
	dispatchedAt: ReadonlyArray<string | null>;
	nowMs: number;
}):
	| { action: "dispatch"; attempt: number }
	| { action: "pending" }
	| { action: "exhausted" } {
	if (params.hasDraft) return { action: "pending" };
	let latest = 0;
	params.dispatchedAt.forEach((at, index) => {
		if (at) latest = index + 1;
	});
	if (latest === 0) return { action: "dispatch", attempt: 1 };
	const at = parseLedgerTime(params.dispatchedAt[latest - 1] as string);
	if (Number.isFinite(at) && params.nowMs - at < REPLY_DRAFT_RETRY_AFTER_MS)
		return { action: "pending" };
	if (latest >= REPLY_DRAFT_MAX_ATTEMPTS) return { action: "exhausted" };
	return { action: "dispatch", attempt: latest + 1 };
}

async function replyDraftDispatchTimes(
	context: BaseContext,
	requestId: string,
): Promise<Array<string | null>> {
	return Promise.all(
		Array.from({ length: REPLY_DRAFT_MAX_ATTEMPTS }, async (_, index) => {
			const row = await getChatDispatchMappingByIdempotencyKey(
				context.db,
				replyDraftDispatchKey(requestId, index + 1),
			);
			return row?.createdAt ?? null;
		}),
	);
}

/**
 * Start a drafting turn. With a request lifetime to borrow, dispatch it
 * directly (the queue consumer's own dispatch, so the idempotency ledger
 * behaves the same) and fall back to the queue only when that dispatch fails;
 * the queue adds its batch wait and a cold consumer to every draft.
 */
async function dispatchReplyDraftTurn(
	context: BaseContext,
	queue: Queue,
	event: AutomationEvent,
): Promise<void> {
	const waitUntil = context.waitUntil;
	if (!waitUntil) {
		await queue.send(event);
		return;
	}
	const direct = async () => {
		const { handleAutomationEventMessage } =
			await import("../../jobs/automation-events");
		const outcome = await handleAutomationEventMessage(context.env, event, {
			waitUntil,
		});
		if (outcome === "retry") await queue.send(event);
	};
	waitUntil(
		direct().catch(async (error) => {
			console.warn("reply-draft direct dispatch failed; queueing", {
				idempotencyKey:
					event.kind === "tedi_turn" ? event.idempotencyKey : undefined,
				error: error instanceof Error ? error.message : String(error),
			});
			await queue.send(event).catch((sendError) => {
				console.error("reply-draft queue fallback failed", {
					error:
						sendError instanceof Error ? sendError.message : String(sendError),
				});
			});
		}),
	);
}

/** The examples block for a drafting prompt; a read failure drafts without it. */
async function replyDraftExamples(
	context: BaseContext,
	policy: AgentTurnTriagePolicy,
	params: { orgId: string; targetUserId: string; request: InteractionRow },
): Promise<string> {
	const { examples } = policy.drafting;
	if (!examples.enabled) return "";
	try {
		return await buildReplyDraftExamplesBlock(context.db, {
			...params,
			count: examples.count,
		});
	} catch (error) {
		console.warn("reply-draft examples unavailable", {
			requestId: params.request.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return "";
	}
}

async function requireInteraction(
	context: BaseContext,
	orgId: string,
	requestId: string,
): Promise<InteractionRow> {
	const request = await getWorkInteraction(context.db, {
		orgId,
		interactionId: requestId,
	});
	if (!request)
		throw createError(ErrorCodes.NOT_FOUND, "Work interaction not found");
	return request;
}

/**
 * Delivery of a proposed draft. `auto` only when every guardrail holds:
 * policy `autoSend.enabled`, the drafter asserted `reversible`, the question
 * is quiet (checked by the caller and the DB insert guard), it carries a
 * `metadata.sessionId`, fewer than `autoSend.maxConsecutive` of that
 * session's earlier questions were auto-answered since the user last replied
 * there, and every Clef `deliveryGate` check passes over the question's
 * prompt and the draft body. Anything else, including a gate model failure,
 * is `review`. `gate` is the gate audit, null when the gate was not reached.
 */
export async function decideReplyDraftDelivery(
	context: Pick<BaseContext, "db" | "env">,
	params: {
		policy: AgentTurnTriagePolicy;
		reversible: boolean;
		body: string;
		request: InteractionRow;
		targetUserId: string;
	},
): Promise<{
	delivery: AgentReplyDraftDelivery;
	gate: AgentReplyDeliveryGateResult | null;
}> {
	const review = { delivery: "review", gate: null } as const;
	const { autoSend } = params.policy;
	if (!autoSend.enabled || params.reversible !== true) return review;
	if (autoSend.maxConsecutive <= 0) return review;
	const metadata = params.request.metadata as Record<string, unknown>;
	const sessionId = metadata.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) return review;
	const consecutive = await countConsecutiveAutoReplies(context.db, {
		orgId: params.request.orgId,
		interactionId: params.request.id,
		targetUserId: params.targetUserId,
		sessionId,
		createdAt: params.request.createdAt,
		limit: autoSend.maxConsecutive,
	});
	if (consecutive >= autoSend.maxConsecutive) return review;
	const gate = await evaluateReplyDraftGate(context.env, {
		gate: params.policy.deliveryGate ?? DEFAULT_AGENT_REPLY_DELIVERY_GATE,
		agentMessage: params.request.prompt,
		draftReply: params.body,
	});
	return { delivery: gate.status === "pass" ? "auto" : "review", gate };
}

const requestReplyDraft = draftWriteOs.requestReplyDraft.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		const request = await requireInteraction(context, orgId, input.requestId);
		if (
			actor.type !== "user" ||
			request.targetType !== "user" ||
			request.targetId !== actor.id
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the question's target user may request a reply draft",
			);
		}
		const observedAt = new Date().toISOString();
		const questionReason = replyDraftQuestionIneligibility(request, observedAt);
		if (questionReason) return { status: "ineligible", reason: questionReason };
		const { policy } = await readPolicyStateFor(context, actor.id, orgId);
		if (!policy.drafting.enabled)
			return { status: "ineligible", reason: "drafting_disabled" };
		const tediId = await activeDraftingTediId(context, policy, orgId);
		if (!tediId) return { status: "ineligible", reason: "no_drafting_tedi" };

		const queue = context.env.AUTOMATION_EVENTS;
		if (!queue) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Automation queue binding is not configured",
			);
		}
		// Every read the prompt needs, plus the attempt state, in one round.
		const [latestDraft, dispatchedAt, sessions, examples, board, skill] =
			await Promise.all([
				getLatestReplyDraft(context.db, { orgId, interactionId: request.id }),
				replyDraftDispatchTimes(context, request.id),
				listWorkAgentSessions(context.db, {
					organizationId: orgId,
					userId: actor.id,
					includeEnded: false,
					now: observedAt,
				}),
				replyDraftExamples(context, policy, {
					orgId,
					targetUserId: actor.id,
					request,
				}),
				replyDraftBoard(context, orgId, request),
				replyDraftSkill(context, orgId, {
					slug: policy.drafting.skillSlug,
					tediId,
				}),
			]);
		const next = nextReplyDraftAttempt({
			hasDraft: latestDraft !== null,
			dispatchedAt,
			nowMs: Date.parse(observedAt),
		});
		if (next.action === "pending") return { status: "queued" };
		if (next.action === "exhausted")
			return { status: "ineligible", reason: "attempts_exhausted" };
		const key = replyDraftDispatchKey(request.id, next.attempt);
		const event: AutomationEvent = AutomationEventSchema.parse({
			kind: "tedi_turn",
			organizationId: orgId,
			tediId,
			content: renderReplyDraftPrompt({
				request,
				sessions,
				skillSlug: policy.drafting.skillSlug,
				skillContent: skill,
				board,
				turnTypeChoices: policy.turnTypeChoices,
				examples,
			}),
			// One drafting turn per attempt: the dispatch ledger makes redelivery
			// and repeat requests of the same attempt no-ops.
			idempotencyKey: key,
			// A fresh conversation per attempt: a draft never queues behind, or
			// inherits the state of, the tedi's main conversation or a failed
			// earlier attempt.
			conversationId: key,
			source: `${REPLY_DRAFT_SOURCE}:v${REPLY_DRAFT_PROMPT_VERSION}`,
		});
		await dispatchReplyDraftTurn(context, queue, event);
		return { status: "queued" };
	},
);

const proposeReplyDraft = draftWriteOs.proposeReplyDraft.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		if (actor.type !== "tedi") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the configured drafting tedi may propose a reply draft",
			);
		}
		const request = await requireInteraction(context, orgId, input.requestId);
		const targetUserId =
			request.targetType === "user" ? request.targetId : null;
		const { policy } = await readPolicyStateFor(context, targetUserId, orgId);
		if (
			!targetUserId ||
			!policy.drafting.enabled ||
			policy.drafting.tediId !== actor.id
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the configured drafting tedi may propose a reply draft",
			);
		}
		const now = new Date().toISOString();
		const reason = replyDraftQuestionIneligibility(request, now);
		if (reason) {
			throw createError(
				ErrorCodes.UNPROCESSABLE_CONTENT,
				`Question cannot be drafted: ${reason}`,
			);
		}
		const { delivery, gate } = await decideReplyDraftDelivery(context, {
			policy,
			reversible: input.reversible,
			body: input.body,
			request,
			targetUserId,
		});
		try {
			const draft = await insertReplyDraft(context.db, {
				id: crypto.randomUUID(),
				orgId,
				interactionId: request.id,
				drafterId: actor.id,
				body: input.body,
				rationale: input.rationale,
				turnType: input.turnType ?? null,
				delivery,
				gate: gate as Record<string, JsonValue> | null,
				now,
			});
			return { draftId: draft.id, delivery: draft.delivery };
		} catch (error) {
			rethrowWorkControlError(error, { invalidPrincipal: "forbidden" });
		}
	},
);

const getReplyDraftAcceptanceProcedure = readOs.getReplyDraftAcceptance.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		if (actor.type !== "user") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Reply-draft acceptance belongs to a Tedix user identity",
			);
		}
		const { policy } = await readPolicyStateFor(context, actor.id, orgId);
		const byTurnType = await getReplyDraftAcceptance(
			context.db,
			{ orgId, targetUserId: actor.id, since: input.since },
			policy.eligibility,
		);
		return { byTurnType, policy: policy.eligibility };
	},
);

export const agentTurnTriageContractRouter = os.router({
	triage,
	labelReply,
	getPolicy,
	updatePolicy,
	requestReplyDraft,
	proposeReplyDraft,
	getReplyDraftAcceptance: getReplyDraftAcceptanceProcedure,
});
