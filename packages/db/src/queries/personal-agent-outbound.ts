import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	gte,
	isNotNull,
	isNull,
	lt,
	ne,
	notExists,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	PersonalAgentOutcome,
	PersonalAgentEnrollment,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import type { DbQueryClient } from "../query-client";
import { organizationMembers } from "../schema/organization-members";
import { tediEmailAddresses } from "../schema/tedi-email";
import { userConfigs } from "../schema/user-configs";
import {
	workInteractionResponses,
	workInteractions,
} from "../schema/work-factory";
import {
	workEvents,
	workEvidence,
	workEvidenceVerifications,
	workItemComments,
	workItemCorroborations,
	workItems,
} from "../schema/work-items";

export interface PersonalAgentOutcomeSource {
	orgId: string;
	userId: string;
	enrollment: string;
	contribution: string;
	workItemId: string;
	interactionId: string;
	responseId: string;
	body: string;
	metadata: string;
	decidedAt: string;
	sourceVersion: number;
	verificationId: string | null;
	evidenceId: string | null;
	evidenceUri: string | null;
	evidenceVersion: string | null;
	observationSource: string | null;
	observerType: string | null;
	observerId: string | null;
	observationState: string | null;
	observedAt: string | null;
	sourceKey: string;
}

const ENROLLMENT_NAMESPACE = "personal-agent-inbound.v1";
const w = alias(workItems, "w");
const cfg = alias(userConfigs, "cfg");
const i = alias(workInteractions, "i");
const r = alias(workInteractionResponses, "r");
const o = alias(workEvents, "o");

/** A user's direct, final answer: no agent session, actor, triage or auto-draft. */
function directUserAnswer(userId: SQLWrapper | string) {
	return and(
		eq(r.responderType, "user"),
		eq(r.responderId, userId),
		eq(r.resolvesRequest, true),
		eq(r.responseKind, "answer"),
		isNull(r.responderSessionId),
		isNull(r.responderExternalSessionKey),
		sql`json_extract(${r.metadata},'$.actor') IS NULL`,
		sql`coalesce(json_extract(${r.metadata},'$.source'),'') NOT IN ('triage-fyi','auto-reply')`,
		sql`coalesce(json_extract(${r.metadata},'$.draftOutcome'),'')<>'auto'`,
	);
}

/** The active enrollment row for one user and `${orgId}:${agentId}` key. */
function activeEnrollment(userId: string, key: string) {
	return and(
		eq(cfg.userId, userId),
		eq(cfg.namespace, ENROLLMENT_NAMESPACE),
		eq(cfg.key, key),
		sql`json_extract(${cfg.value},'$.active')=1`,
	);
}

/** Existing response/verification ledgers are the backlog; no second queue. */
export function listPersonalAgentOutcomeSources(
	db: DbQueryClient,
	limit = 50,
): Promise<PersonalAgentOutcomeSource[]> {
	const v = alias(workEvidenceVerifications, "v");
	const e = alias(workEvidence, "e");
	const c = alias(workItemCorroborations, "c");
	const observations = db.$with("observations").as(
		db
			.select({
				id: sql<string>`${v.id}`.as("id"),
				orgId: sql<string>`${v.orgId}`.as("org_id"),
				workItemId: sql<string>`${v.workItemId}`.as("work_item_id"),
				evidenceId: sql<string | null>`${v.evidenceId}`.as("evidence_id"),
				evidenceUri: sql<string | null>`${e.uri}`.as("evidence_uri"),
				evidenceVersion: sql<string | null>`cast(${e.version} AS TEXT)`.as(
					"evidence_version",
				),
				observationSource: sql<string>`${v.source}`.as("observation_source"),
				observerType: sql<string>`${v.verifierType}`.as("observer_type"),
				observerId: sql<string>`${v.verifierId}`.as("observer_id"),
				observationState:
					sql<string>`CASE WHEN ${v.matchesClaim}=0 THEN 'contradicted'
				 WHEN ${e.version}=1 OR json_extract(${v.claimed},'$.evidenceVersion')=${e.version} THEN 'verified' ELSE 'unverified' END`.as(
						"observation_state",
					),
				matchesClaim: sql<number>`${v.matchesClaim}`.as("matches_claim"),
				observedAt: sql<string>`${v.observedAt}`.as("observed_at"),
			})
			.from(v)
			.innerJoin(
				e,
				and(
					eq(e.orgId, v.orgId),
					eq(e.id, v.evidenceId),
					eq(e.workItemId, v.workItemId),
				),
			)
			.unionAll(
				db
					.select({
						id: sql<string>`${c.id}`.as("id"),
						orgId: sql<string>`${c.orgId}`.as("org_id"),
						workItemId: sql<string>`${c.workItemId}`.as("work_item_id"),
						evidenceId: sql<string | null>`NULL`.as("evidence_id"),
						evidenceUri: sql<string | null>`${c.evidenceRef}`.as(
							"evidence_uri",
						),
						evidenceVersion: sql<string | null>`${c.occurredAt}`.as(
							"evidence_version",
						),
						observationSource: sql<string>`'work_confirmation'`.as(
							"observation_source",
						),
						observerType: sql<string>`${c.principalType}`.as("observer_type"),
						observerId: sql<string>`${c.principalId}`.as("observer_id"),
						observationState:
							sql<string>`CASE WHEN ${c.stance}='corroborates' THEN 'corroborated' ELSE 'contradicted' END`.as(
								"observation_state",
							),
						matchesClaim:
							sql<number>`CASE WHEN ${c.stance}='corroborates' THEN 1 ELSE 0 END`.as(
								"matches_claim",
							),
						observedAt: sql<string>`${c.occurredAt}`.as("observed_at"),
					})
					.from(c),
			),
	);
	const newer = alias(workInteractionResponses, "newer");
	const observationKey = sql`coalesce(${observations.id} || ':' || ${observations.observedAt} || ':' || ${observations.matchesClaim} || ':' || ${observations.evidenceVersion},'decision')`;
	return db
		.with(observations)
		.select({
			orgId: sql<string>`${w.orgId}`.as("orgId"),
			userId: sql<string>`${cfg.userId}`.as("userId"),
			enrollment: sql<string>`${cfg.value}`.as("enrollment"),
			contribution:
				sql<string>`json_extract(${w.provenance},'$.personalAgentContribution')`.as(
					"contribution",
				),
			workItemId: sql<string>`${w.id}`.as("workItemId"),
			interactionId: sql<string>`${i.id}`.as("interactionId"),
			responseId: sql<string>`${r.id}`.as("responseId"),
			body: sql<string>`${r.body}`.as("body"),
			metadata: sql<string>`${r.metadata}`.as("metadata"),
			decidedAt: sql<string>`${r.respondedAt}`.as("decidedAt"),
			sourceVersion: sql<number>`${r.resolvedRequestVersion}`.as(
				"sourceVersion",
			),
			verificationId: sql<string | null>`${observations.id}`.as(
				"verificationId",
			),
			evidenceId: sql<string | null>`${observations.evidenceId}`.as(
				"evidenceId",
			),
			evidenceUri: sql<string | null>`${observations.evidenceUri}`.as(
				"evidenceUri",
			),
			evidenceVersion: sql<string | null>`${observations.evidenceVersion}`.as(
				"evidenceVersion",
			),
			observationSource: sql<
				string | null
			>`${observations.observationSource}`.as("observationSource"),
			observerType: sql<string | null>`${observations.observerType}`.as(
				"observerType",
			),
			observerId: sql<string | null>`${observations.observerId}`.as(
				"observerId",
			),
			observationState: sql<string | null>`${observations.observationState}`.as(
				"observationState",
			),
			observedAt: sql<string | null>`${observations.observedAt}`.as(
				"observedAt",
			),
			sourceKey: sql<string>`(${r.id} || ':' || ${observationKey})`.as(
				"sourceKey",
			),
		})
		.from(w)
		.innerJoin(
			cfg,
			and(
				eq(cfg.namespace, ENROLLMENT_NAMESPACE),
				sql`${cfg.userId}=json_extract(${w.provenance},'$.personalAgentContribution.representedUserId')`,
				sql`${cfg.key}=${w.orgId} || ':' || json_extract(${w.provenance},'$.personalAgentContribution.sourceAgentId')`,
				sql`json_extract(${cfg.value},'$.active')=1`,
			),
		)
		.innerJoin(
			i,
			and(
				eq(i.orgId, w.orgId),
				eq(i.workItemId, w.id),
				eq(i.targetType, "user"),
				eq(i.targetId, cfg.userId),
				sql`json_extract(${i.metadata},'$.source')='personal-agent-inbound'`,
			),
		)
		.innerJoin(
			r,
			and(
				eq(r.orgId, i.orgId),
				eq(r.interactionId, i.id),
				directUserAnswer(cfg.userId),
			),
		)
		.leftJoin(
			observations,
			and(eq(observations.orgId, w.orgId), eq(observations.workItemId, w.id)),
		)
		.where(
			and(
				sql`json_extract(${cfg.value},'$.orgId')=${w.orgId}`,
				sql`json_extract(${cfg.value},'$.representedUserId')=${cfg.userId}`,
				notExists(
					db
						.select({ one: sql`1` })
						.from(newer)
						.where(
							and(
								eq(newer.orgId, r.orgId),
								eq(newer.interactionId, r.interactionId),
								eq(newer.responderType, "user"),
								eq(newer.responderId, r.responderId),
								eq(newer.resolvesRequest, true),
								gt(newer.resolvedRequestVersion, r.resolvedRequestVersion),
							),
						),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(o)
						.where(
							and(
								eq(o.orgId, w.orgId),
								sql`${o.id}='pa-outcome:' || ${r.id} || ':' || ${observationKey}`,
							),
						),
				),
			),
		)
		.orderBy(
			asc(r.respondedAt),
			asc(r.id),
			asc(observations.observedAt),
			asc(observations.id),
		)
		.limit(limit);
}

/** Outcome and its always-on Work comment commit together. Deterministic ids fence races. */
export async function recordPersonalAgentOutcome(
	db: DbQueryClient,
	orgId: string,
	outcome: PersonalAgentOutcome,
) {
	await db.batch([
		db
			.insert(workEvents)
			.select(
				db
					.select({
						id: sql<string>`${outcome.id}`.as("id"),
						orgId: sql<string>`${orgId}`.as("org_id"),
						workItemId: sql<string>`${outcome.workItemId}`.as("work_item_id"),
						eventType: sql<string>`'personal_agent.outcome_recorded'`.as(
							"event_type",
						),
						actorType: sql<"system">`'system'`.as("actor_type"),
						actorId: sql<string>`'personal-agent-outbound'`.as("actor_id"),
						payload: sql<
							Record<string, JsonValue>
						>`${JSON.stringify(outcome)}`.as("payload"),
						occurredAt: sql<string>`${outcome.recordedAt}`.as("occurred_at"),
					})
					.from(cfg)
					.where(
						activeEnrollment(
							outcome.decidedBy,
							`${orgId}:${outcome.sourceAgentId}`,
						),
					),
			)
			.onConflictDoNothing({ target: workEvents.id }),
		db
			.insert(workItemComments)
			.select(
				db
					.select({
						id: workEvents.id,
						orgId: workEvents.orgId,
						workItemId: workEvents.workItemId,
						authorType: sql<"system">`'system'`.as("author_type"),
						authorId: sql<string>`'personal-agent-outbound'`.as("author_id"),
						body: sql<string>`${workEvents.payload}`.as("body"),
						metadata: sql<
							Record<string, JsonValue>
						>`json_object('personalAgentOutcome',json(${workEvents.payload}))`.as(
							"metadata",
						),
						createdAt: workEvents.occurredAt,
					})
					.from(workEvents)
					.where(
						and(eq(workEvents.orgId, orgId), eq(workEvents.id, outcome.id)),
					),
			)
			.onConflictDoNothing({ target: workItemComments.id }),
	]);
}

export function listPersonalAgentOutcomes(
	db: DbQueryClient,
	p: {
		orgId: string;
		userId: string;
		enrollmentId: string;
		after?: number;
		limit?: number;
		workItemId?: string;
		newestFirst?: boolean;
	},
) {
	return db
		.select({
			id: workEvents.id,
			sequence: workEvents.sequence,
			workItemId: workEvents.workItemId,
			payload: workEvents.payload,
			emailStatus: sql<
				string | null
			>`(SELECT json_extract(d.payload,'$.status') FROM work_events d WHERE d.org_id=${workEvents.orgId} AND d.id=${workEvents.id} || ':email')`.as(
				"email_status",
			),
			acknowledgedAt: sql<
				string | null
			>`(SELECT a.occurred_at FROM work_events a WHERE a.org_id=${workEvents.orgId} AND a.id=${workEvents.id} || ':ack')`.as(
				"acknowledged_at",
			),
		})
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, p.orgId),
				eq(workEvents.eventType, "personal_agent.outcome_recorded"),
				sql`json_extract(${workEvents.payload},'$.sourceAgentId')=${p.enrollmentId}`,
				sql`json_extract(${workEvents.payload},'$.decidedBy')=${p.userId}`,
				p.workItemId ? eq(workEvents.workItemId, p.workItemId) : undefined,
				gt(workEvents.sequence, p.after ?? 0),
			),
		)
		.orderBy(
			p.newestFirst ? desc(workEvents.sequence) : asc(workEvents.sequence),
		)
		.limit(p.limit ?? 100);
}

export async function getPersonalAgentEmailDestination(
	db: DbQueryClient,
	e: PersonalAgentEnrollment,
) {
	if (!e.delivery?.email) return null;
	const m = organizationMembers;
	const a = tediEmailAddresses;
	const [row] = await db
		.select({ to: m.email, from: a.address })
		.from(m)
		.innerJoin(
			a,
			and(eq(a.organizationId, m.organizationId), eq(a.status, "active")),
		)
		.where(
			and(
				eq(m.organizationId, e.orgId),
				eq(m.id, e.delivery.email.memberId),
				eq(m.kind, "external_agent"),
				eq(m.status, "active"),
				eq(m.representedUserId, e.representedUserId),
				isNotNull(m.userId),
				ne(m.userId, e.representedUserId),
				eq(a.id, e.delivery.email.senderAddressId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function claimPersonalAgentEmail(
	db: DbQueryClient,
	e: PersonalAgentEnrollment,
	outcome: PersonalAgentOutcome,
) {
	const rows = await db
		.insert(workEvents)
		.select(
			db
				.select({
					id: sql<string>`${`${outcome.id}:email`}`.as("id"),
					orgId: sql<string>`${e.orgId}`.as("org_id"),
					workItemId: sql<string>`${outcome.workItemId}`.as("work_item_id"),
					eventType: sql<string>`'personal_agent.outcome_email'`.as(
						"event_type",
					),
					actorType: sql<"system">`'system'`.as("actor_type"),
					actorId: sql<string>`'personal-agent-outbound'`.as("actor_id"),
					payload: sql<
						Record<string, JsonValue>
					>`${JSON.stringify({ outcomeId: outcome.id, status: "sending_or_unknown" })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${new Date().toISOString()}`.as(
						"occurred_at",
					),
				})
				.from(cfg)
				.where(
					and(
						activeEnrollment(e.representedUserId, `${e.orgId}:${e.id}`),
						sql`json_extract(${cfg.value},'$.delivery.email.memberId')=${e.delivery?.email?.memberId ?? null}`,
						sql`json_extract(${cfg.value},'$.delivery.email.senderAddressId')=${e.delivery?.email?.senderAddressId ?? null}`,
					),
				),
		)
		.onConflictDoNothing({ target: workEvents.id })
		.returning({ id: workEvents.id });
	return rows.length === 1;
}

export async function finishPersonalAgentEmail(
	db: DbQueryClient,
	orgId: string,
	outcomeId: string,
	result: {
		status: "sent" | "sending_or_unknown";
		messageId?: string;
	},
) {
	await db
		.update(workEvents)
		.set({
			payload: { outcomeId, ...result },
			occurredAt: new Date().toISOString(),
		})
		.where(
			and(eq(workEvents.orgId, orgId), eq(workEvents.id, `${outcomeId}:email`)),
		);
}

export function listPendingPersonalAgentEmails(db: DbQueryClient, limit = 50) {
	const d = alias(workEvents, "d");
	return db
		.select({
			orgId: sql<string>`${o.orgId}`.as("orgId"),
			payload: sql<string>`${o.payload}`.as("payload"),
			enrollment: sql<string>`${cfg.value}`.as("enrollment"),
		})
		.from(o)
		.innerJoin(
			cfg,
			and(
				eq(cfg.namespace, ENROLLMENT_NAMESPACE),
				sql`${cfg.userId}=json_extract(${o.payload},'$.decidedBy')`,
				sql`${cfg.key}=${o.orgId} || ':' || json_extract(${o.payload},'$.sourceAgentId')`,
			),
		)
		.where(
			and(
				// Literal, not a bound value: only then can the planner use the
				// partial idx_work_events_personal_outcome_sequence.
				sql`${o.eventType} = 'personal_agent.outcome_recorded'`,
				sql`json_extract(${cfg.value},'$.active')=1`,
				sql`json_extract(${cfg.value},'$.delivery.email') IS NOT NULL`,
				notExists(
					db
						.select({ one: sql`1` })
						.from(d)
						.where(and(eq(d.orgId, o.orgId), sql`${d.id}=${o.id} || ':email'`)),
				),
			),
		)
		.orderBy(asc(o.sequence))
		.limit(limit);
}

export async function acknowledgePersonalAgentOutcome(
	db: DbQueryClient,
	p: {
		orgId: string;
		userId: string;
		enrollmentId: string;
		outcomeId: string;
		reminderId?: string;
	},
) {
	const rows = await db
		.select({ workItemId: workEvents.workItemId })
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, p.orgId),
				eq(workEvents.id, p.outcomeId),
				eq(workEvents.eventType, "personal_agent.outcome_recorded"),
				sql`json_extract(${workEvents.payload},'$.sourceAgentId')=${p.enrollmentId}`,
				sql`json_extract(${workEvents.payload},'$.decidedBy')=${p.userId}`,
			),
		)
		.limit(1);
	if (!rows[0]) return false;
	await db
		.insert(workEvents)
		.select(
			db
				.select({
					id: sql<string>`${`${p.outcomeId}:ack`}`.as("id"),
					orgId: sql<string>`${p.orgId}`.as("org_id"),
					workItemId: sql<string>`${rows[0].workItemId}`.as("work_item_id"),
					eventType: sql<string>`'personal_agent.outcome_acknowledged'`.as(
						"event_type",
					),
					actorType: sql<"system">`'system'`.as("actor_type"),
					actorId: sql<string>`${`personal-agent:${p.enrollmentId}`}`.as(
						"actor_id",
					),
					payload: sql<
						Record<string, JsonValue>
					>`${JSON.stringify({ outcomeId: p.outcomeId, sourceAgentId: p.enrollmentId, reminderId: p.reminderId ?? null, evidenceSource: "agent_report" })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${new Date().toISOString()}`.as(
						"occurred_at",
					),
				})
				.from(cfg)
				.where(activeEnrollment(p.userId, `${p.orgId}:${p.enrollmentId}`)),
		)
		.onConflictDoNothing({ target: workEvents.id });
	return true;
}

/** Captured-finding cohort, exact [start,end) window; each external key contributes once. */
export async function getPersonalAgentValue(
	db: DbQueryClient,
	e: PersonalAgentEnrollment,
	start: string,
	end: string,
) {
	const cohort = db.$with("cohort").as(
		db
			.select({
				id: sql<string>`min(${w.id})`.as("id"),
				kind: sql<
					string | null
				>`json_extract(${w.provenance},'$.personalAgentContribution.kind')`.as(
					"kind",
				),
			})
			.from(w)
			.where(
				and(
					eq(w.orgId, e.orgId),
					sql`json_extract(${w.provenance},'$.personalAgentContribution.sourceAgentId')=${e.id}`,
					sql`json_extract(${w.provenance},'$.personalAgentContribution.representedUserId')=${e.representedUserId}`,
					gte(w.createdAt, start),
					lt(w.createdAt, end),
				),
			)
			.groupBy(
				sql`json_extract(${w.provenance},'$.personalAgentContribution.externalFindingId')`,
			),
	);
	const outcomes = db.$with("outcomes").as(
		db
			.select({
				id: sql<string>`${o.id}`.as("id"),
				payload: sql<string>`${o.payload}`.as("payload"),
			})
			.from(o)
			.innerJoin(cohort, eq(cohort.id, o.workItemId))
			.where(
				and(
					eq(o.orgId, e.orgId),
					eq(o.eventType, "personal_agent.outcome_recorded"),
					lt(o.occurredAt, end),
				),
			),
	);
	const count = sql<number>`count(*)`;
	const proposals = (...extra: SQL[]) =>
		db
			.select({ n: count })
			.from(cohort)
			.where(and(eq(cohort.kind, "proposal"), ...extra));
	const outcomesInState = (state: string) =>
		db
			.select({ n: count })
			.from(outcomes)
			.where(
				sql`json_extract(${outcomes.payload},'$.execution.state')=${state}`,
			);
	const a = alias(workEvents, "a");
	const acknowledgements = (selection: SQL<number>) =>
		db
			.select({ n: selection })
			.from(a)
			.innerJoin(outcomes, sql`${a.id}=${outcomes.id} || ':ack'`)
			.where(and(eq(a.orgId, e.orgId), lt(a.occurredAt, end)));
	const d = alias(workEvents, "d");
	const deckCard = and(
		eq(i.orgId, e.orgId),
		eq(i.workItemId, cohort.id),
		eq(i.targetType, "user"),
		eq(i.targetId, e.representedUserId),
		sql`json_extract(${i.metadata},'$.source')='personal-agent-inbound'`,
		sql`json_extract(${i.metadata},'$.decisionDeck') IS NOT NULL`,
		lt(i.createdAt, end),
	);
	// A grouped CTE has no natural single row, so the aggregate over cohort
	// supplies it; every other count is a scalar subquery as before.
	const [row] = await db
		.with(cohort, outcomes)
		.select({
			findings: count.as("findings"),
			decisionFindings: sql<number>`${proposals()}`.as("decisionFindings"),
			decisionCards: sql<number>`${proposals(
				exists(
					db
						.select({ one: sql`1` })
						.from(i)
						.where(deckCard),
				),
			)}`.as("decisionCards"),
			fyiFindings: sql<number>`${db
				.select({ n: count })
				.from(cohort)
				.where(eq(cohort.kind, "fyi"))}`.as("fyiFindings"),
			decidedFromCard: sql<number>`${proposals(
				exists(
					db
						.select({ one: sql`1` })
						.from(i)
						.innerJoin(r, and(eq(r.orgId, i.orgId), eq(r.interactionId, i.id)))
						.where(
							and(
								deckCard,
								directUserAnswer(e.representedUserId),
								lt(r.respondedAt, end),
								sql`json_extract(${r.metadata},'$.cardAction') IS NOT NULL`,
							),
						),
				),
			)}`.as("decidedFromCard"),
			outcomes: sql<number>`${db.select({ n: count }).from(outcomes)}`.as(
				"outcomes",
			),
			verifiedOutcomes: sql<number>`${outcomesInState("verified")}`.as(
				"verifiedOutcomes",
			),
			corroboratedOutcomes: sql<number>`${outcomesInState("corroborated")}`.as(
				"corroboratedOutcomes",
			),
			emailsSent: sql<number>`${db
				.select({ n: count })
				.from(d)
				.innerJoin(outcomes, sql`${d.id}=${outcomes.id} || ':email'`)
				.where(
					and(
						eq(d.orgId, e.orgId),
						sql`json_extract(${d.payload},'$.status')='sent'`,
						lt(d.occurredAt, end),
					),
				)}`.as("emailsSent"),
			acknowledgedOutcomes: sql<number>`${acknowledgements(count)}`.as(
				"acknowledgedOutcomes",
			),
			agentReportedReminderRetirements: sql<number>`${acknowledgements(
				sql<number>`count(DISTINCT json_extract(${a.payload},'$.reminderId'))`,
			)}`.as("agentReportedReminderRetirements"),
		})
		.from(cohort);
	return row!;
}
