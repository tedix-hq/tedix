/**
 * Agent decision journal (`record_agent_decision`,
 * `record_agent_decision_outcome`, `list_agent_decisions`).
 *
 * A decision an agent made on its own becomes:
 *  - one learning event (surface `agent_decision`, kind `decided`, issue key
 *    `agent:<actor>:<decision class>`) carrying the DecisionEnvelope;
 *  - decision graph links, which the graph projection picks up;
 *  - a "Decided by <agent>" Feed update for the person the agent works for.
 * An outcome is a second event on the same surface; a reverted or partial one
 * is also an agent-mistake signal (`work_fix`, `agent-mistake:<class>`) that
 * lesson mining turns into a reviewed directive proposal.
 *
 * Nothing here grants authority, creates approvals, or executes anything.
 * The daily review card is an ordinary Deck question addressed to the person.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import {
	type AgentDecision,
	type ListAgentDecisionsResult,
	type RecordAgentDecisionInput,
	type RecordAgentDecisionOutcomeInput,
	type RecordAgentDecisionResult,
} from "@tedix/api-contract/schemas/agent-decisions";
import type { ActivityFeedItem } from "@tedix/api-contract/schemas/os-activity-feed";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	AGENT_DECISION_OUTCOME_EVENT_KIND,
	AGENT_DECISION_OUTCOME_SCHEMA,
	AGENT_DECISION_REVIEW_CLASS,
	AGENT_DECISION_REVIEW_SOURCE,
	AGENT_DECISION_SCHEMA,
	AGENT_DECISION_SURFACE,
	agentDecisionAskable,
	agentDecisionClassId,
	agentDecisionEnvelope,
	agentDecisionFeedItems,
	agentDecisionNeedsPerson,
	agentDecisionReviewText,
	agentDecisionsFromEvents,
	agentDecisionStandings,
	agentDisplayName,
	agentSessionHarness,
	slug,
} from "@tedix/api-contract/utils/agent-decision-journal";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	AGENT_DECISION_TARGET_TYPE,
	countAgentDecisionsRecordedSince,
	getActiveMemberUserIdForSubject,
	getAgentDecisionEvent,
	listAgentDecisionJournal,
	listAgentDecisionRecorders,
} from "@tedix/db/queries/agent-decisions";
import {
	getExternalAgentPrincipal,
	getExternalAgentPrincipalByCredential,
	listExternalAgentPrincipalsRepresentingUser,
} from "@tedix/db/queries/external-agent-identity/principals";
import { listExternalAgentSessionKeys } from "@tedix/db/queries/external-agent-identity/sessions";
import {
	type DecisionEdgeInput,
	upsertDecisionEdges,
} from "@tedix/db/queries/decision-graph";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import {
	LearningFeedbackIdempotencyConflictError,
	recordLearningInteraction,
} from "@tedix/db/queries/learning-feedback";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { toJsonRecord } from "@tedix/db/utils/json";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import {
	observedLearningActor,
	observedLearningEventId,
} from "./learning-interaction-recorder";

type LearningActor = ReturnType<typeof observedLearningActor>;

/** Same surface the learning-feed miner groups agent mistakes on. */
export const AGENT_MISTAKE_SURFACE = "work_fix";
const JOURNAL_PRODUCER = "agent-decision-journal";
const EDGE_SOURCE = "agent_decision";
const MAX_BACKDATE_MS = 30 * 86_400_000;
const MAX_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const STANDING_WINDOW_MS = 30 * DAY_MS;

type JournalContext = Pick<
	BaseContext,
	| "db"
	| "authType"
	| "user"
	| "userId"
	| "tediId"
	| "descopeUserId"
	| "serviceAccount"
	| "apiKey"
	| "externalAgentPrincipalId"
>;

/** The person an external-agent principal acts for, when its binding says so. */
function representedUserId(
	principal: Awaited<ReturnType<typeof getExternalAgentPrincipal>>,
): string | null {
	if (!principal) return null;
	if (principal.credentialBindingType === "owner_user")
		return principal.credentialBindingId;
	const represented = principal.metadata.representedUserId;
	return typeof represented === "string" && represented.trim()
		? represented
		: null;
}

/**
 * The accountable actor a journaled decision is stamped with. An external
 * Agent-Session call carries no user/api-key identity of its own, so the
 * decision is attributed to the person or credential its principal represents —
 * the same identity the Feed and the morning review look it up by.
 */
async function journalActor(
	context: JournalContext,
	orgId: string,
): Promise<LearningActor> {
	const actor = observedLearningActor(context);
	if (actor.actorType !== "unknown" && actor.actorId) return actor;
	if (context.externalAgentPrincipalId) {
		const principal = await getExternalAgentPrincipal(context.db, {
			organizationId: orgId,
			principalId: context.externalAgentPrincipalId,
		});
		const represented = representedUserId(principal);
		if (represented) return { actorType: "user", actorId: represented };
		if (principal?.credentialBindingType === "api_key")
			return {
				actorType: "api_key",
				actorId: principal.credentialBindingId,
			};
		if (principal) return { actorType: "service", actorId: principal.id };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Recording an agent decision requires an identified caller",
	);
}

function decisionTime(occurredAt: string | undefined, now: Date): string {
	if (!occurredAt) return now.toISOString();
	const at = Date.parse(occurredAt);
	if (at > now.getTime() + MAX_SKEW_MS || at < now.getTime() - MAX_BACKDATE_MS)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"occurredAt must be within the last 30 days and not in the future",
		);
	return new Date(at).toISOString();
}

async function journalConfig(db: DbQueryClient, orgId: string) {
	return (await getDecisionLearningConfig(db, orgId)).agentDecisions;
}

async function recordOnce(
	db: DbQueryClient,
	input: Parameters<typeof recordLearningInteraction>[1],
) {
	try {
		return await recordLearningInteraction(db, input);
	} catch (error) {
		if (error instanceof LearningFeedbackIdempotencyConflictError)
			throw createError(
				ErrorCodes.CONFLICT,
				"This decision was already recorded by another caller",
			);
		throw error;
	}
}

export async function recordAgentDecision(
	context: JournalContext,
	orgId: string,
	input: RecordAgentDecisionInput,
	now = new Date(),
): Promise<RecordAgentDecisionResult> {
	const actor = await journalActor(context, orgId);
	const config = await journalConfig(context.db, orgId);
	const occurredAt = decisionTime(input.occurredAt, now);
	const recent = await countAgentDecisionsRecordedSince(context.db, {
		organizationId: orgId,
		agentSession: input.agentSession,
		since: new Date(now.getTime() - 3_600_000).toISOString(),
	});
	if (recent >= config.perSessionHourlyLimit)
		throw createError(
			ErrorCodes.TOO_MANY_REQUESTS,
			`This Agent-Session already recorded ${recent} decisions in the last hour; record the decisions that matter, not every step`,
		);
	const [work, prior] = await Promise.all([
		input.workItemId
			? getWorkItemById(context.db, input.workItemId, orgId)
			: Promise.resolve(null),
		input.priorDecisionId
			? getAgentDecisionEvent(context.db, {
					organizationId: orgId,
					decisionId: input.priorDecisionId,
				})
			: Promise.resolve(null),
	]);
	if (input.workItemId && !work)
		throw createError(ErrorCodes.NOT_FOUND, "Work item not found");
	if (input.priorDecisionId && !prior)
		throw createError(ErrorCodes.NOT_FOUND, "Earlier decision not found");

	const name = agentDisplayName(input);
	const harness = agentSessionHarness(input.agentSession);
	const classId = agentDecisionClassId(name, input.decisionClass);
	const envelope = agentDecisionEnvelope(input, classId);
	const needsPerson = agentDecisionNeedsPerson(input);
	const askable = agentDecisionAskable(
		{ needsPerson, confidence: input.confidence },
		config,
	);
	const chosen = input.options.find((option) => option.id === input.chosen)!;
	const { event, duplicate } = await recordOnce(context.db, {
		organizationId: orgId,
		actorType: actor.actorType,
		actorId: actor.actorId,
		tediId: actor.actorType === "tedi" ? actor.actorId : null,
		clientEventId: await observedLearningEventId(
			"agent-decision",
			input.agentSession,
			input.decisionClass,
			input.question,
			input.chosen,
			occurredAt.slice(0, 16),
		),
		signalClass: "governance",
		eventKind: "decided",
		scopeKind: "organization",
		scopeId: orgId,
		issueKey: classId,
		surface: AGENT_DECISION_SURFACE,
		targetType: work ? "work_item" : null,
		targetId: work?.id ?? null,
		threadId: input.agentSession,
		runId: null,
		occurredAt,
		metadata: toJsonRecord({
			schema: AGENT_DECISION_SCHEMA,
			classId,
			decisionClass: input.decisionClass,
			agent: { name, harness, session: input.agentSession },
			question: input.question,
			options: input.options,
			chosen: input.chosen,
			reason: input.reason,
			reversibility: input.reversibility,
			protectedEffects: input.protectedEffects,
			tasteOrStrategy: input.tasteOrStrategy,
			confidence: input.confidence,
			needsPerson,
			workItemId: work?.id ?? null,
			projectId: work?.projectId ?? null,
			outputId: input.outputId ?? null,
			commitShas: input.commitShas,
			priorDecisionId: input.priorDecisionId ?? null,
			priorRelation: input.priorDecisionId ? input.priorRelation : null,
			approvalRef: input.approvalRef ?? null,
			decision: envelope,
		}),
	});

	type Link = Omit<DecisionEdgeInput, "from" | "source">;
	const links: Link[] = [
		{
			kind: "decided_by",
			to: { kind: "agent", id: slug(name) },
			note: `${name} (${harness})`,
		},
	];
	if (work)
		links.push({
			kind: "about",
			to: { kind: "work_item", id: work.id },
			note: work.title,
		});
	if (input.outputId)
		links.push({ kind: "about", to: { kind: "output", id: input.outputId } });
	if (prior)
		links.push({
			kind: input.priorRelation,
			to: { kind: "decision", id: prior.id },
			note: String(prior.metadata?.question ?? "").slice(0, 280) || null,
		});
	for (const sha of input.commitShas)
		links.push({
			kind: "evidence",
			to: { kind: "commit", id: sha },
			note: `commit ${sha.slice(0, 10)}`,
		});
	const edges: DecisionEdgeInput[] = links.map((link) => ({
		...link,
		from: { kind: "decision", id: event.id },
		source: EDGE_SOURCE,
		occurredAt,
		evidenceRef: `learning_event:${event.id}`,
	}));
	const { written } = await upsertDecisionEdges(context.db, orgId, edges);
	return {
		decisionId: event.id,
		duplicate,
		classId,
		needsPerson,
		askable,
		edgesWritten: written,
		notice: needsPerson
			? input.approvalRef
				? "Recorded with its approval reference."
				: `Recorded as context only. ${chosen.label} touches something that needs a person: ask through an approval before acting, if you have not.`
			: null,
	};
}

export async function recordAgentDecisionOutcome(
	context: JournalContext,
	orgId: string,
	input: RecordAgentDecisionOutcomeInput,
	now = new Date(),
) {
	const actor = await journalActor(context, orgId);
	const decision = await getAgentDecisionEvent(context.db, {
		organizationId: orgId,
		decisionId: input.decisionId,
	});
	if (!decision)
		throw createError(ErrorCodes.NOT_FOUND, "Agent decision not found");
	const occurredAt = decisionTime(input.occurredAt, now);
	const meta = decision.metadata ?? {};
	const classId = decision.issueKey ?? String(meta.classId ?? "agent:unknown");
	const decisionClass = String(meta.decisionClass ?? "general");
	const agent = (meta.agent ?? {}) as Record<string, unknown>;
	const wrong = input.outcome !== "worked";
	const correction = wrong && input.by === "person";
	const { event, duplicate } = await recordOnce(context.db, {
		organizationId: orgId,
		actorType: actor.actorType,
		actorId: actor.actorId,
		tediId: actor.actorType === "tedi" ? actor.actorId : null,
		clientEventId: await observedLearningEventId(
			"agent-decision-outcome",
			decision.id,
			input.outcome,
			input.by,
			input.evidence,
		),
		signalClass: "governance",
		eventKind: AGENT_DECISION_OUTCOME_EVENT_KIND[input.outcome],
		scopeKind: "organization",
		scopeId: orgId,
		issueKey: classId,
		surface: AGENT_DECISION_SURFACE,
		targetType: AGENT_DECISION_TARGET_TYPE,
		targetId: decision.id,
		threadId: decision.threadId,
		runId: null,
		occurredAt,
		metadata: toJsonRecord({
			schema: AGENT_DECISION_OUTCOME_SCHEMA,
			outcome: input.outcome,
			by: input.by,
			correction,
			evidence: input.evidence,
			commitShas: input.commitShas,
			classId,
		}),
	});
	let mistakeRecorded = false;
	if (wrong) {
		const mistake = await recordOnce(context.db, {
			organizationId: orgId,
			actorType: "service",
			actorId: JOURNAL_PRODUCER,
			tediId: null,
			clientEventId: `agent-decision-mistake:${decision.id}`,
			signalClass: "quality",
			eventKind: "undone",
			scopeKind: "organization",
			scopeId: orgId,
			issueKey: `agent-mistake:${slug(decisionClass, 64)}`,
			surface: AGENT_MISTAKE_SURFACE,
			targetType: AGENT_DECISION_TARGET_TYPE,
			targetId: decision.id,
			threadId: null,
			runId: null,
			occurredAt,
			metadata: toJsonRecord({
				title: `${input.outcome === "reverted" ? "Undone" : "Partly changed"} agent decision: ${String(meta.question ?? "").slice(0, 160)}`,
				harness: agent.harness ?? null,
				agentSession: decision.threadId,
				commitSha: input.commitShas[0] ?? null,
				correction,
			}),
		});
		mistakeRecorded = !mistake.duplicate;
	}
	if (input.commitShas.length)
		await upsertDecisionEdges(
			context.db,
			orgId,
			input.commitShas.map((sha) => ({
				kind: "evidence",
				from: { kind: "decision", id: decision.id },
				to: { kind: "commit", id: sha },
				source: `${EDGE_SOURCE}_outcome`,
				note: `${input.outcome}: commit ${sha.slice(0, 10)}`,
				occurredAt,
				evidenceRef: `learning_event:${event.id}`,
			})),
		);
	return {
		decisionId: decision.id,
		outcomeEventId: event.id,
		duplicate,
		correction,
		mistakeRecorded,
	};
}

async function journalDecisions(
	db: DbQueryClient,
	orgId: string,
	input: {
		since: string;
		limit: number;
		recordedBy?: {
			actors: Array<{
				actorType: LearningActor["actorType"];
				actorId: string;
			}>;
			threadIds?: string[];
		};
	},
	config: Awaited<ReturnType<typeof journalConfig>>,
): Promise<AgentDecision[]> {
	const events = await listAgentDecisionJournal(db, {
		organizationId: orgId,
		...input,
	});
	return agentDecisionsFromEvents(events, config);
}

export async function listAgentDecisions(
	context: Pick<BaseContext, "db">,
	orgId: string,
	input: { since?: string; decisionClass?: string; limit: number },
	now = new Date(),
): Promise<ListAgentDecisionsResult> {
	const config = await journalConfig(context.db, orgId);
	const since = input.since ?? new Date(now.getTime() - DAY_MS).toISOString();
	const [recent, history] = await Promise.all([
		journalDecisions(context.db, orgId, { since, limit: input.limit }, config),
		journalDecisions(
			context.db,
			orgId,
			{
				since: new Date(now.getTime() - STANDING_WINDOW_MS).toISOString(),
				limit: 300,
			},
			config,
		),
	]);
	const decisions = input.decisionClass
		? recent.filter((d) => d.decisionClass === input.decisionClass)
		: recent;
	return {
		decisions,
		classes: agentDecisionStandings(history, config).filter((standing) =>
			decisions.some((d) => d.classId === standing.classId),
		),
		summary: agentDecisionReviewText(decisions),
	};
}

/**
 * The identities whose recorded decisions this viewer may see: the caller's own
 * credential plus, for external agents and the people they act for, the
 * principal's bound credential and its sessions' Agent-Session keys (journaled
 * as `threadId`). A decision recorded by any of those counts as the viewer's
 * own agents' work.
 */
async function viewerDecisionScopes(
	context: JournalContext,
	orgId: string,
): Promise<{
	actors: Array<{ actorType: LearningActor["actorType"]; actorId: string }>;
	threadIds: string[];
} | null> {
	const viewer = observedLearningActor(context);
	const actors: Array<{
		actorType: LearningActor["actorType"];
		actorId: string;
	}> =
		viewer.actorType !== "unknown" && viewer.actorId
			? [{ actorType: viewer.actorType, actorId: viewer.actorId }]
			: [];
	const principalIds = new Set<string>();
	if (context.externalAgentPrincipalId) {
		principalIds.add(context.externalAgentPrincipalId);
		const principal = await getExternalAgentPrincipal(context.db, {
			organizationId: orgId,
			principalId: context.externalAgentPrincipalId,
		});
		const represented = representedUserId(principal);
		if (represented) actors.push({ actorType: "user", actorId: represented });
		if (principal?.credentialBindingType === "api_key")
			actors.push({
				actorType: "api_key",
				actorId: principal.credentialBindingId,
			});
		if (principal) actors.push({ actorType: "service", actorId: principal.id });
	}
	if (context.apiKey?.id) {
		const bound = await getExternalAgentPrincipalByCredential(context.db, {
			organizationId: orgId,
			credentialBindingId: context.apiKey.id,
		});
		if (bound) {
			principalIds.add(bound.id);
			const represented = representedUserId(bound);
			if (represented) actors.push({ actorType: "user", actorId: represented });
		}
	}
	if (viewer.actorType === "user" && viewer.actorId) {
		const userId =
			context.userId ??
			(await getActiveMemberUserIdForSubject(context.db, {
				organizationId: orgId,
				subject: viewer.actorId,
			}));
		if (userId && userId !== viewer.actorId)
			actors.push({ actorType: "user", actorId: userId });
		for (const principal of await listExternalAgentPrincipalsRepresentingUser(
			context.db,
			{ organizationId: orgId, userId: userId ?? viewer.actorId },
		)) {
			principalIds.add(principal.id);
			if (principal.credentialBindingType === "api_key")
				actors.push({
					actorType: "api_key",
					actorId: principal.credentialBindingId,
				});
		}
	}
	const threadIds = principalIds.size
		? await listExternalAgentSessionKeys(context.db, {
				organizationId: orgId,
				principalIds: [...principalIds],
			})
		: [];
	if (!actors.length && !threadIds.length) return null;
	return { actors, threadIds };
}

/** The viewer's own agents' decisions of the last three days, for the Feed. */
export async function agentDecisionFeed(
	context: JournalContext,
	orgId: string,
	now = new Date(),
): Promise<ActivityFeedItem[]> {
	const recordedBy = await viewerDecisionScopes(context, orgId);
	if (!recordedBy) return [];
	const config = await journalConfig(context.db, orgId);
	const decisions = await journalDecisions(
		context.db,
		orgId,
		{
			since: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
			limit: 50,
			recordedBy,
		},
		config,
	);
	return agentDecisionFeedItems(decisions);
}

function localParts(now: Date, timeZone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(now)
			.map((part) => [part.type, part.value]),
	);
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		hour: Number(parts.hour),
	};
}

async function reviewCardId(key: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(key),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * At most one Deck card per person and local day, after the organization's
 * review hour, when their agents made a decision a person may want to check
 * in the last 24 hours. Routine decisions stay in the Feed digest. Rides the
 * maintenance tick; the deterministic card id makes retries harmless.
 */
export async function runAgentDecisionMorningReview(
	db: DbQueryClient,
	now: Date,
): Promise<{ agentDecisionReviews: number }> {
	if (now.getUTCMinutes() % 10 >= 2) return { agentDecisionReviews: 0 };
	const since = new Date(now.getTime() - DAY_MS).toISOString();
	const recorders = await listAgentDecisionRecorders(db, {
		since,
		limit: 25,
	}).catch((error) => {
		console.error("[agent-decision-review] recorders unavailable", {
			exception: safeExceptionTopology(error),
		});
		return [];
	});
	const configs = new Map<
		string,
		Awaited<ReturnType<typeof getDecisionLearningConfig>>
	>();
	let created = 0;
	for (const { organizationId, userId } of recorders) {
		try {
			const learning =
				configs.get(organizationId) ??
				(await getDecisionLearningConfig(db, organizationId));
			configs.set(organizationId, learning);
			const config = learning.agentDecisions;
			const local = localParts(now, learning.timezone);
			if (!config.morningReview || local.hour < config.reviewHour) continue;
			const id = await reviewCardId(
				`agent-decision-review:${organizationId}:${userId}:${local.date}`,
			);
			if (
				await getWorkInteraction(db, {
					orgId: organizationId,
					interactionId: id,
				})
			)
				continue;
			const decisions = await journalDecisions(
				db,
				organizationId,
				{
					since,
					limit: 100,
					recordedBy: { actors: [{ actorType: "user", actorId: userId }] },
				},
				config,
			);
			const askable = decisions.filter((d) => d.askable);
			const anchor =
				askable.find((d) => d.workItemId) ??
				decisions.find((d) => d.workItemId);
			if (askable.length === 0 || !anchor?.workItemId) continue;
			const recipient = await getActiveMemberUserIdForSubject(db, {
				organizationId,
				subject: userId,
			});
			if (!recipient) continue;
			const text = agentDecisionReviewText(decisions);
			const proposal = `Review ${askable.length} agent decision${askable.length === 1 ? "" : "s"} from overnight?`;
			const reasoning = askable
				.slice(0, 10)
				.map(
					(d) =>
						`• ${d.question} → ${d.chosen.label} (${d.agent.name}). ${d.reason.slice(0, 300)}`,
				)
				.join("\n");
			const decision = DecisionEnvelopeSchema.parse({
				version: 1,
				kind: "decision",
				classId: AGENT_DECISION_REVIEW_CLASS,
				proposal,
				whyNow: text,
				recommendation:
					"Keep them unless one looks wrong. Tell the agent which to undo.",
				reversibility: "two_way",
				// Judging an agent's judgement calls is the owner's call: this
				// routes the review to the Deck instead of the Feed.
				tasteOrStrategy: true,
				protectedEffects: [],
				blastRadius: "Decisions your agents already made",
				confidence: null,
				costOfWaiting: "The decisions stay in place until someone undoes them.",
				reasoning: reasoning || text,
				options: [
					{
						id: "keep",
						label: "Keep them",
						intent: "approve",
						consequence: "Records your review. Nothing is changed.",
						cost: "None",
					},
					{
						id: "undo-some",
						label: "Undo some",
						intent: "reject",
						consequence:
							"Say which to undo. The agent undoes it and records your correction.",
						cost: "The agent's time to undo",
					},
					{
						id: "later",
						label: "Later",
						intent: "later",
						consequence: "Keeps this review open.",
						cost: "None",
					},
				],
			});
			try {
				await createWorkInteraction(db, {
					id,
					orgId: organizationId,
					workItemId: anchor.workItemId,
					kind: "question",
					subject: proposal,
					prompt: `${text}\n\n${reasoning}`,
					creator: { type: "system", id: "tedix" },
					targetType: "user",
					targetId: recipient,
					metadata: {
						source: AGENT_DECISION_REVIEW_SOURCE,
						reviewDate: local.date,
						reason: text,
						decisionIds: askable.map((d) => d.id),
						decisionDeck: decision,
					},
					now: now.toISOString(),
				});
				created++;
			} catch (error) {
				if (
					!(await getWorkInteraction(db, {
						orgId: organizationId,
						interactionId: id,
					}))
				)
					throw error;
			}
		} catch (error) {
			console.error("[agent-decision-review] failed", {
				organizationId,
				exception: safeExceptionTopology(error),
			});
		}
	}
	return { agentDecisionReviews: created };
}
