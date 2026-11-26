import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	notExists,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../core-store/client";
import {
	booleanValue,
	coreStore,
	jsonParameter,
	jsonRead as coreJsonRead,
} from "../core-store/dialect";
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
	workEvents as d1WorkEvents,
	workEvidence,
	workItemComments as d1WorkItemComments,
	workItems,
} from "../schema/work-items";

import {
	currentConfirmationEvent,
	observationEvent,
} from "./work-items/observation-ledger";

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
function outboundAlias<T extends Parameters<typeof sqliteAlias>[0]>(
	db: object,
	table: T,
	name: string,
): T {
	return (
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)(coreTable(db, table), name)
			: sqliteAlias(table, name)
	) as T;
}
function outboundAliases(db: object) {
	return {
		w: outboundAlias(db, workItems, "w"),
		cfg: outboundAlias(db, userConfigs, "cfg"),
		i: outboundAlias(db, workInteractions, "i"),
		r: outboundAlias(db, workInteractionResponses, "r"),
		o: outboundAlias(db, d1WorkEvents, "o"),
	};
}
// JSON operators must bind before concatenation and casts in ledger keys.
function jsonRead(...args: Parameters<typeof coreJsonRead>) {
	return sql`(${coreJsonRead(...args)})`;
}
function jsonText(db: object, column: SQLWrapper): SQL<string> {
	return coreStore(db) === "postgres" ? sql`(${column})::text` : sql`${column}`;
}
function enrollmentActive(db: object, value: SQLWrapper) {
	return coreStore(db) === "postgres"
		? sql`${jsonRead(db, value, ["active"], "json")} IN ('true'::jsonb, '1'::jsonb)`
		: sql`${jsonRead(db, value, ["active"])} = 1`;
}

/** A user's direct, final answer: no agent session, actor, triage or auto-draft. */
function directUserAnswer(db: object, userId: SQLWrapper | string) {
	const r = outboundAlias(db, workInteractionResponses, "r");
	return and(
		eq(r.responderType, "user"),
		eq(r.responderId, userId),
		eq(r.resolvesRequest, true),
		eq(r.responseKind, "answer"),
		isNull(r.responderSessionId),
		isNull(r.responderExternalSessionKey),
		sql`${jsonRead(db, r.metadata, ["actor"])} IS NULL`,
		sql`coalesce(${jsonRead(db, r.metadata, ["source"])},'') NOT IN ('triage-fyi','auto-reply')`,
		sql`coalesce(${jsonRead(db, r.metadata, ["draftOutcome"])},'')<>'auto'`,
	);
}

/** The active enrollment row for one user and `${orgId}:${agentId}` key. */
function activeEnrollment(db: object, userId: string, key: string) {
	const cfg = outboundAlias(db, userConfigs, "cfg");
	return and(
		eq(cfg.userId, userId),
		eq(cfg.namespace, ENROLLMENT_NAMESPACE),
		eq(cfg.key, key),
		enrollmentActive(db, cfg.value),
	);
}

/** Existing response/observation event ledgers are the backlog; no second queue. */
export function listPersonalAgentOutcomeSources(
	db: DbQueryClient,
	limit = 50,
): Promise<PersonalAgentOutcomeSource[]> {
	const { w, cfg, i, r, o } = outboundAliases(db);
	const v = outboundAlias(db, d1WorkEvents, "v");
	const e = outboundAlias(db, workEvidence, "e");
	const c = outboundAlias(db, d1WorkEvents, "c");
	const enrolledOrgs = db
		.select({ orgId: jsonRead(db, cfg.value, ["orgId"]).as("org_id") })
		.from(cfg)
		.where(
			and(
				eq(cfg.namespace, ENROLLMENT_NAMESPACE),
				enrollmentActive(db, cfg.value),
			),
		);
	const observations = db.$with("observations").as(
		db
			.select({
				id: sql<string>`${jsonRead(db, v.payload, ["record", "id"])}`.as("id"),
				orgId: sql<string>`${v.orgId}`.as("org_id"),
				workItemId: sql<string>`${v.workItemId}`.as("work_item_id"),
				evidenceId: sql<
					string | null
				>`${jsonRead(db, v.payload, ["record", "evidenceId"])}`.as(
					"evidence_id",
				),
				evidenceUri: sql<string | null>`${e.uri}`.as("evidence_uri"),
				evidenceVersion: sql<string | null>`cast(${e.version} AS TEXT)`.as(
					"evidence_version",
				),
				observationSource:
					sql<string>`${jsonRead(db, v.payload, ["record", "source"])}`.as(
						"observation_source",
					),
				observerType:
					sql<string>`${jsonRead(db, v.payload, ["record", "verifierType"])}`.as(
						"observer_type",
					),
				observerId:
					sql<string>`${jsonRead(db, v.payload, ["record", "verifierId"])}`.as(
						"observer_id",
					),
				observationState:
					sql<string>`CASE WHEN ${jsonRead(db, v.payload, ["record", "matchesClaim"], "boolean")}=${booleanValue(db, false)} THEN 'contradicted'
				 WHEN ${e.version}=1 OR ${jsonRead(db, v.payload, ["record", "claimed", "evidenceVersion"])}=cast(${e.version} AS TEXT) THEN 'verified' ELSE 'unverified' END`.as(
						"observation_state",
					),
				matchesClaim:
					sql<number>`CASE WHEN ${jsonRead(db, v.payload, ["record", "matchesClaim"], "boolean")}=${booleanValue(db, true)} THEN 1 ELSE 0 END`.as(
						"matches_claim",
					),
				deliveryRevision: sql<string | null>`NULL`.as("delivery_revision"),
				observedAt:
					sql<string>`${jsonRead(db, v.payload, ["record", "observedAt"])}`.as(
						"observed_at",
					),
			})
			.from(v)
			.innerJoin(
				e,
				and(
					eq(e.orgId, v.orgId),
					sql`${e.id}=${jsonRead(db, v.payload, ["record", "evidenceId"])}`,
					eq(e.workItemId, v.workItemId),
				),
			)
			.where(
				and(
					inArray(v.orgId, enrolledOrgs),
					observationEvent(db, v, "verification"),
				),
			)
			.unionAll(
				db
					.select({
						id: sql<string>`${jsonRead(db, c.payload, ["record", "id"])}`.as(
							"id",
						),
						orgId: sql<string>`${c.orgId}`.as("org_id"),
						workItemId: sql<string>`${c.workItemId}`.as("work_item_id"),
						evidenceId: sql<string | null>`NULL`.as("evidence_id"),
						evidenceUri: sql<
							string | null
						>`${jsonRead(db, c.payload, ["record", "evidenceRef"])}`.as(
							"evidence_uri",
						),
						evidenceVersion: sql<
							string | null
						>`${jsonRead(db, c.payload, ["record", "occurredAt"])}`.as(
							"evidence_version",
						),
						observationSource: sql<string>`'work_confirmation'`.as(
							"observation_source",
						),
						observerType:
							sql<string>`${jsonRead(db, c.payload, ["record", "principalType"])}`.as(
								"observer_type",
							),
						observerId:
							sql<string>`${jsonRead(db, c.payload, ["record", "principalId"])}`.as(
								"observer_id",
							),
						observationState:
							sql<string>`CASE WHEN ${jsonRead(db, c.payload, ["record", "stance"])}='corroborates' THEN 'corroborated' ELSE 'contradicted' END`.as(
								"observation_state",
							),
						matchesClaim:
							sql<number>`CASE WHEN ${jsonRead(db, c.payload, ["record", "stance"])}='corroborates' THEN 1 ELSE 0 END`.as(
								"matches_claim",
							),
						deliveryRevision: sql<
							string | null
						>`${jsonRead(db, c.payload, ["deliveryRevision"])}`.as(
							"delivery_revision",
						),
						observedAt:
							sql<string>`${jsonRead(db, c.payload, ["record", "occurredAt"])}`.as(
								"observed_at",
							),
					})
					.from(c)
					.where(
						and(
							inArray(c.orgId, enrolledOrgs),
							currentConfirmationEvent(db, c),
						),
					),
			),
	);
	const newer = outboundAlias(db, workInteractionResponses, "newer");
	const observationKey = sql`coalesce(${observations.id} || ':' || ${observations.observedAt} || ':' || ${observations.matchesClaim} || ':' || ${observations.evidenceVersion} || coalesce(':' || ${observations.deliveryRevision}, ''),'decision')`;
	return db
		.with(observations)
		.select({
			orgId: sql<string>`${w.orgId}`.as("orgId"),
			userId: sql<string>`${cfg.userId}`.as("userId"),
			enrollment: jsonText(db, cfg.value).as("enrollment"),
			contribution: jsonText(
				db,
				jsonRead(db, w.provenance, ["personalAgentContribution"], "json"),
			).as("contribution"),
			workItemId: sql<string>`${w.id}`.as("workItemId"),
			interactionId: sql<string>`${i.id}`.as("interactionId"),
			responseId: sql<string>`${r.id}`.as("responseId"),
			body: sql<string>`${r.body}`.as("body"),
			metadata: jsonText(db, r.metadata).as("metadata"),
			decidedAt: sql<string>`${r.respondedAt}`.as("decidedAt"),
			sourceVersion: sql<number>`${r.resolvedRequestVersion}`
				.mapWith(Number)
				.as("sourceVersion"),
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
				sql`${cfg.userId}=${jsonRead(db, w.provenance, ["personalAgentContribution", "representedUserId"])}`,
				sql`${cfg.key}=${w.orgId} || ':' || ${jsonRead(db, w.provenance, ["personalAgentContribution", "sourceAgentId"])}`,
				enrollmentActive(db, cfg.value),
			),
		)
		.innerJoin(
			i,
			and(
				eq(i.orgId, w.orgId),
				eq(i.workItemId, w.id),
				eq(i.targetType, "user"),
				eq(i.targetId, cfg.userId),
				sql`${coreStore(db) === "postgres" ? jsonRead(db, i.metadata, ["source"]) : i.source}='personal-agent-inbound'`,
			),
		)
		.innerJoin(
			r,
			and(
				eq(r.orgId, i.orgId),
				eq(r.interactionId, i.id),
				directUserAnswer(db, cfg.userId),
			),
		)
		.leftJoin(
			observations,
			and(eq(observations.orgId, w.orgId), eq(observations.workItemId, w.id)),
		)
		.where(
			and(
				sql`${jsonRead(db, cfg.value, ["orgId"])}=${w.orgId}`,
				sql`${jsonRead(db, cfg.value, ["representedUserId"])}=${cfg.userId}`,
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
	const { cfg } = outboundAliases(db);
	const workEvents = coreTable(db, d1WorkEvents);
	const workItemComments = coreTable(db, d1WorkItemComments);
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
						>`${jsonParameter(db, outcome)}`.as("payload"),
						occurredAt: sql<string>`${outcome.recordedAt}`.as("occurred_at"),
					})
					.from(cfg)
					.where(
						activeEnrollment(
							db,
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
						body: jsonText(db, workEvents.payload).as("body"),
						metadata: sql<Record<string, JsonValue>>`${
							coreStore(db) === "postgres"
								? sql`jsonb_build_object('personalAgentOutcome', ${workEvents.payload})`
								: sql`json_object('personalAgentOutcome',json(${workEvents.payload}))`
						}`.as("metadata"),
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
	const workEvents = coreTable(db, d1WorkEvents);
	const d = outboundAlias(db, d1WorkEvents, "delivery");
	const a = outboundAlias(db, d1WorkEvents, "acknowledgement");
	const delivery = db
		.select({ status: jsonRead(db, d.payload, ["status"]).as("status") })
		.from(d)
		.where(
			and(
				eq(d.orgId, workEvents.orgId),
				eq(d.id, sql`${workEvents.id} || ':email'`),
			),
		)
		.limit(1);
	const acknowledgement = db
		.select({ at: a.occurredAt })
		.from(a)
		.where(
			and(
				eq(a.orgId, workEvents.orgId),
				eq(a.id, sql`${workEvents.id} || ':ack'`),
			),
		)
		.limit(1);
	return db
		.select({
			id: workEvents.id,
			sequence: workEvents.sequence,
			workItemId: workEvents.workItemId,
			payload: workEvents.payload,
			emailStatus: sql<string | null>`${delivery}`.as("email_status"),
			acknowledgedAt: sql<string | null>`${acknowledgement}`.as(
				"acknowledged_at",
			),
		})
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, p.orgId),
				eq(workEvents.eventType, "personal_agent.outcome_recorded"),
				sql`${jsonRead(db, workEvents.payload, ["sourceAgentId"])}=${p.enrollmentId}`,
				sql`${jsonRead(db, workEvents.payload, ["decidedBy"])}=${p.userId}`,
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
	const m = coreTable(db, organizationMembers);
	const a = coreTable(db, tediEmailAddresses);
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
	const workEvents = coreTable(db, d1WorkEvents);
	const { cfg } = outboundAliases(db);
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
					>`${jsonParameter(db, { outcomeId: outcome.id, status: "sending_or_unknown" })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${new Date().toISOString()}`.as(
						"occurred_at",
					),
				})
				.from(cfg)
				.where(
					and(
						activeEnrollment(db, e.representedUserId, `${e.orgId}:${e.id}`),
						sql`${jsonRead(db, cfg.value, ["delivery", "email", "memberId"])}=${e.delivery?.email?.memberId ?? null}`,
						sql`${jsonRead(db, cfg.value, ["delivery", "email", "senderAddressId"])}=${e.delivery?.email?.senderAddressId ?? null}`,
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
	const workEvents = coreTable(db, d1WorkEvents);
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
	const { o, cfg } = outboundAliases(db);
	const d = outboundAlias(db, d1WorkEvents, "d");
	return db
		.select({
			orgId: sql<string>`${o.orgId}`.as("orgId"),
			payload: jsonText(db, o.payload).as("payload"),
			enrollment: jsonText(db, cfg.value).as("enrollment"),
		})
		.from(o)
		.innerJoin(
			cfg,
			and(
				eq(cfg.namespace, ENROLLMENT_NAMESPACE),
				sql`${cfg.userId}=${jsonRead(db, o.payload, ["decidedBy"])}`,
				sql`${cfg.key}=${o.orgId} || ':' || ${jsonRead(db, o.payload, ["sourceAgentId"])}`,
			),
		)
		.where(
			and(
				// Literal, not a bound value: only then can the planner use the
				// partial idx_work_events_personal_outcome_sequence.
				sql`${o.eventType} = 'personal_agent.outcome_recorded'`,
				enrollmentActive(db, cfg.value),
				sql`${jsonRead(db, cfg.value, ["delivery", "email"])} IS NOT NULL`,
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
	const workEvents = coreTable(db, d1WorkEvents);
	const { cfg } = outboundAliases(db);
	const rows = await db
		.select({ workItemId: workEvents.workItemId })
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, p.orgId),
				eq(workEvents.id, p.outcomeId),
				eq(workEvents.eventType, "personal_agent.outcome_recorded"),
				sql`${jsonRead(db, workEvents.payload, ["sourceAgentId"])}=${p.enrollmentId}`,
				sql`${jsonRead(db, workEvents.payload, ["decidedBy"])}=${p.userId}`,
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
					>`${jsonParameter(db, { outcomeId: p.outcomeId, sourceAgentId: p.enrollmentId, reminderId: p.reminderId ?? null, evidenceSource: "agent_report" })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${new Date().toISOString()}`.as(
						"occurred_at",
					),
				})
				.from(cfg)
				.where(activeEnrollment(db, p.userId, `${p.orgId}:${p.enrollmentId}`)),
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
	const { w, o, i, r } = outboundAliases(db);
	const cohort = db.$with("cohort").as(
		db
			.select({
				id: sql<string>`min(${w.id})`.as("id"),
				kind: sql<string | null>`${
					coreStore(db) === "postgres"
						? sql`(array_agg(${jsonRead(db, w.provenance, ["personalAgentContribution", "kind"])} ORDER BY ${w.id}))[1]`
						: jsonRead(db, w.provenance, ["personalAgentContribution", "kind"])
				}`.as("kind"),
			})
			.from(w)
			.where(
				and(
					eq(w.orgId, e.orgId),
					sql`${jsonRead(db, w.provenance, ["personalAgentContribution", "sourceAgentId"])}=${e.id}`,
					sql`${jsonRead(db, w.provenance, ["personalAgentContribution", "representedUserId"])}=${e.representedUserId}`,
					gte(w.createdAt, start),
					lt(w.createdAt, end),
				),
			)
			.groupBy(
				jsonRead(db, w.provenance, [
					"personalAgentContribution",
					"externalFindingId",
				]),
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
	const count = sql<number>`count(*)`.mapWith(Number);
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
				sql`${jsonRead(db, outcomes.payload, ["execution", "state"])}=${state}`,
			);
	const a = outboundAlias(db, d1WorkEvents, "a");
	const acknowledgements = (selection: SQL<number>) =>
		db
			.select({ n: selection })
			.from(a)
			.innerJoin(outcomes, sql`${a.id}=${outcomes.id} || ':ack'`)
			.where(and(eq(a.orgId, e.orgId), lt(a.occurredAt, end)));
	const d = outboundAlias(db, d1WorkEvents, "d");
	const deckCard = and(
		eq(i.orgId, e.orgId),
		eq(i.workItemId, cohort.id),
		eq(i.targetType, "user"),
		eq(i.targetId, e.representedUserId),
		sql`${coreStore(db) === "postgres" ? jsonRead(db, i.metadata, ["source"]) : i.source}='personal-agent-inbound'`,
		sql`${jsonRead(db, i.metadata, ["decisionDeck"])} IS NOT NULL`,
		lt(i.createdAt, end),
	);
	// A grouped CTE has no natural single row, so the aggregate over cohort
	// supplies it; every other count is a scalar subquery as before.
	const [row] = await db
		.with(cohort, outcomes)
		.select({
			findings: count.as("findings"),
			decisionFindings: sql<number>`${proposals()}`
				.mapWith(Number)
				.as("decisionFindings"),
			decisionCards: sql<number>`${proposals(
				exists(
					db
						.select({ one: sql`1` })
						.from(i)
						.where(deckCard),
				),
			)}`
				.mapWith(Number)
				.as("decisionCards"),
			fyiFindings: sql<number>`${db
				.select({ n: count })
				.from(cohort)
				.where(eq(cohort.kind, "fyi"))}`
				.mapWith(Number)
				.as("fyiFindings"),
			decidedFromCard: sql<number>`${proposals(
				exists(
					db
						.select({ one: sql`1` })
						.from(i)
						.innerJoin(r, and(eq(r.orgId, i.orgId), eq(r.interactionId, i.id)))
						.where(
							and(
								deckCard,
								directUserAnswer(db, e.representedUserId),
								lt(r.respondedAt, end),
								sql`${jsonRead(db, r.metadata, ["cardAction"])} IS NOT NULL`,
							),
						),
				),
			)}`
				.mapWith(Number)
				.as("decidedFromCard"),
			outcomes: sql<number>`${db.select({ n: count }).from(outcomes)}`
				.mapWith(Number)
				.as("outcomes"),
			verifiedOutcomes: sql<number>`${outcomesInState("verified")}`
				.mapWith(Number)
				.as("verifiedOutcomes"),
			corroboratedOutcomes: sql<number>`${outcomesInState("corroborated")}`
				.mapWith(Number)
				.as("corroboratedOutcomes"),
			emailsSent: sql<number>`${db
				.select({ n: count })
				.from(d)
				.innerJoin(outcomes, sql`${d.id}=${outcomes.id} || ':email'`)
				.where(
					and(
						eq(d.orgId, e.orgId),
						sql`${jsonRead(db, d.payload, ["status"])}='sent'`,
						lt(d.occurredAt, end),
					),
				)}`
				.mapWith(Number)
				.as("emailsSent"),
			acknowledgedOutcomes: sql<number>`${acknowledgements(count)}`
				.mapWith(Number)
				.as("acknowledgedOutcomes"),
			agentReportedReminderRetirements: sql<number>`${acknowledgements(
				sql<number>`count(DISTINCT ${jsonRead(db, a.payload, ["reminderId"])})`,
			)}`
				.mapWith(Number)
				.as("agentReportedReminderRetirements"),
		})
		.from(cohort);
	return row!;
}
