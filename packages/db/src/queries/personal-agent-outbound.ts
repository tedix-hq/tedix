import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type {
	PersonalAgentOutcome,
	PersonalAgentEnrollment,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import type { DbQueryClient } from "../query-client";
import { workEvents } from "../schema/work-items";

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

/** Existing response/verification ledgers are the backlog; no second queue. */
export function listPersonalAgentOutcomeSources(db: DbQueryClient, limit = 50) {
	return db.all<PersonalAgentOutcomeSource>(sql`
		WITH observations AS (
		 SELECT v.id, v.org_id, v.work_item_id, v.evidence_id, e.uri AS evidence_uri,
		 cast(e.version AS TEXT) AS evidence_version, v.source AS observation_source,
		 v.verifier_type AS observer_type, v.verifier_id AS observer_id,
		 CASE WHEN v.matches_claim=0 THEN 'contradicted'
		 WHEN e.version=1 OR json_extract(v.claimed,'$.evidenceVersion')=e.version THEN 'verified' ELSE 'unverified' END AS observation_state,
		 v.matches_claim, v.observed_at FROM work_evidence_verifications v
		 JOIN work_evidence e ON e.org_id=v.org_id AND e.id=v.evidence_id AND e.work_item_id=v.work_item_id
		 UNION ALL
		 SELECT c.id,c.org_id,c.work_item_id,NULL,c.evidence_ref,c.occurred_at,'work_confirmation',c.principal_type,c.principal_id,
		 CASE WHEN c.stance='corroborates' THEN 'corroborated' ELSE 'contradicted' END,
		 CASE WHEN c.stance='corroborates' THEN 1 ELSE 0 END,c.occurred_at FROM work_item_corroborations c
		)
		SELECT w.org_id AS orgId, cfg.user_id AS userId, cfg.value AS enrollment,
		json_extract(w.provenance,'$.personalAgentContribution') AS contribution,
		w.id AS workItemId, i.id AS interactionId, r.id AS responseId, r.body AS body,
		r.metadata AS metadata, r.responded_at AS decidedAt,
		r.resolved_request_version AS sourceVersion,
		v.id AS verificationId, v.evidence_id AS evidenceId, v.evidence_uri AS evidenceUri,
		v.evidence_version AS evidenceVersion, v.observation_source AS observationSource,
		v.observer_type AS observerType, v.observer_id AS observerId, v.observation_state AS observationState,
		v.observed_at AS observedAt,
		(r.id || ':' || coalesce(v.id || ':' || v.observed_at || ':' || v.matches_claim || ':' || v.evidence_version,'decision')) AS sourceKey
		FROM work_items w
		JOIN user_configs cfg ON cfg.namespace='personal-agent-inbound.v1'
		 AND cfg.user_id=json_extract(w.provenance,'$.personalAgentContribution.representedUserId')
		 AND cfg.key=w.org_id || ':' || json_extract(w.provenance,'$.personalAgentContribution.sourceAgentId')
		 AND json_extract(cfg.value,'$.active')=1
		JOIN work_interactions i ON i.org_id=w.org_id AND i.work_item_id=w.id
		 AND i.target_type='user' AND i.target_id=cfg.user_id
		 AND json_extract(i.metadata,'$.source')='personal-agent-inbound'
		JOIN work_interaction_responses r ON r.org_id=i.org_id AND r.interaction_id=i.id
		 AND r.responder_type='user' AND r.responder_id=cfg.user_id AND r.resolves_request=1
		 AND r.response_kind='answer'
		 AND r.responder_session_id IS NULL AND r.responder_external_session_key IS NULL
		 AND json_extract(r.metadata,'$.actor') IS NULL
		 AND coalesce(json_extract(r.metadata,'$.source'),'') NOT IN ('triage-fyi','auto-reply')
		 AND coalesce(json_extract(r.metadata,'$.draftOutcome'),'')<>'auto'
		LEFT JOIN observations v ON v.org_id=w.org_id AND v.work_item_id=w.id
		WHERE json_extract(cfg.value,'$.orgId')=w.org_id
		 AND json_extract(cfg.value,'$.representedUserId')=cfg.user_id
		 AND NOT EXISTS (SELECT 1 FROM work_interaction_responses newer
		 WHERE newer.org_id=r.org_id AND newer.interaction_id=r.interaction_id
		 AND newer.responder_type='user' AND newer.responder_id=r.responder_id AND newer.resolves_request=1
		 AND newer.resolved_request_version>r.resolved_request_version)
		 AND NOT EXISTS (SELECT 1 FROM work_events o WHERE o.org_id=w.org_id
		 AND o.id='pa-outcome:' || r.id || ':' || coalesce(v.id || ':' || v.observed_at || ':' || v.matches_claim || ':' || v.evidence_version,'decision'))
		ORDER BY r.responded_at, r.id, v.observed_at, v.id LIMIT ${limit}`);
}

/** Outcome and its always-on Work comment commit together. Deterministic ids fence races. */
export async function recordPersonalAgentOutcome(
	db: DbQueryClient,
	orgId: string,
	outcome: PersonalAgentOutcome,
) {
	await db.batch([
		db.run(sql`INSERT INTO work_events (id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
		 SELECT ${outcome.id},${orgId},${outcome.workItemId},'personal_agent.outcome_recorded','system','personal-agent-outbound',${JSON.stringify(outcome)},${outcome.recordedAt}
		 FROM user_configs cfg WHERE cfg.user_id=${outcome.decidedBy} AND cfg.namespace='personal-agent-inbound.v1'
		 AND cfg.key=${`${orgId}:${outcome.sourceAgentId}`} AND json_extract(cfg.value,'$.active')=1
		 ON CONFLICT(id) DO NOTHING`),
		db.run(sql`INSERT INTO work_item_comments (id,org_id,work_item_id,author_type,author_id,body,metadata,created_at)
		 SELECT id,org_id,work_item_id,'system','personal-agent-outbound',payload,json_object('personalAgentOutcome',json(payload)),occurred_at
		 FROM work_events WHERE org_id=${orgId} AND id=${outcome.id}
		 ON CONFLICT(id) DO NOTHING`),
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
	const [row] = await db.all<{ to: string; from: string }>(sql`
		SELECT m.email AS "to", a.address AS "from" FROM organization_members m
		JOIN tedi_email_addresses a ON a.organization_id=m.organization_id AND a.status='active'
		WHERE m.organization_id=${e.orgId} AND m.id=${e.delivery.email.memberId}
		 AND m.kind='external_agent' AND m.status='active' AND m.represented_user_id=${e.representedUserId}
		 AND m.user_id IS NOT NULL AND m.user_id<>${e.representedUserId}
		 AND a.id=${e.delivery.email.senderAddressId} LIMIT 1`);
	return row ?? null;
}

export async function claimPersonalAgentEmail(
	db: DbQueryClient,
	e: PersonalAgentEnrollment,
	outcome: PersonalAgentOutcome,
) {
	const rows = await db.all<{
		id: string;
	}>(sql`INSERT INTO work_events (id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
		SELECT ${`${outcome.id}:email`},${e.orgId},${outcome.workItemId},'personal_agent.outcome_email','system','personal-agent-outbound',
		${JSON.stringify({ outcomeId: outcome.id, status: "sending_or_unknown" })},${new Date().toISOString()}
		FROM user_configs cfg WHERE cfg.user_id=${e.representedUserId} AND cfg.namespace='personal-agent-inbound.v1'
		AND cfg.key=${`${e.orgId}:${e.id}`} AND json_extract(cfg.value,'$.active')=1
		AND json_extract(cfg.value,'$.delivery.email.memberId')=${e.delivery?.email?.memberId ?? null}
		AND json_extract(cfg.value,'$.delivery.email.senderAddressId')=${e.delivery?.email?.senderAddressId ?? null}
		ON CONFLICT(id) DO NOTHING RETURNING id`);
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
	return db.all<{ orgId: string; payload: string; enrollment: string }>(sql`
		SELECT o.org_id AS orgId, o.payload AS payload, cfg.value AS enrollment FROM work_events o
		JOIN user_configs cfg ON cfg.namespace='personal-agent-inbound.v1'
		 AND cfg.user_id=json_extract(o.payload,'$.decidedBy')
		 AND cfg.key=o.org_id || ':' || json_extract(o.payload,'$.sourceAgentId')
		WHERE o.event_type='personal_agent.outcome_recorded' AND json_extract(cfg.value,'$.active')=1
		 AND json_extract(cfg.value,'$.delivery.email') IS NOT NULL
		 AND NOT EXISTS (SELECT 1 FROM work_events d WHERE d.org_id=o.org_id AND d.id=o.id || ':email')
		ORDER BY o.sequence LIMIT ${limit}`);
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
	const rows = await db.all<{
		workItemId: string;
	}>(sql`SELECT work_item_id AS workItemId FROM work_events
		WHERE org_id=${p.orgId} AND id=${p.outcomeId} AND event_type='personal_agent.outcome_recorded'
		AND json_extract(payload,'$.sourceAgentId')=${p.enrollmentId} AND json_extract(payload,'$.decidedBy')=${p.userId} LIMIT 1`);
	if (!rows[0]) return false;
	await db.run(sql`INSERT INTO work_events (id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
		SELECT ${`${p.outcomeId}:ack`},${p.orgId},${rows[0].workItemId},'personal_agent.outcome_acknowledged','system',${`personal-agent:${p.enrollmentId}`},
		${JSON.stringify({ outcomeId: p.outcomeId, sourceAgentId: p.enrollmentId, reminderId: p.reminderId ?? null, evidenceSource: "agent_report" })},${new Date().toISOString()}
		FROM user_configs cfg WHERE cfg.user_id=${p.userId} AND cfg.namespace='personal-agent-inbound.v1'
		AND cfg.key=${`${p.orgId}:${p.enrollmentId}`} AND json_extract(cfg.value,'$.active')=1
		ON CONFLICT(id) DO NOTHING`);
	return true;
}

/** Captured-finding cohort, exact [start,end) window; each external key contributes once. */
export async function getPersonalAgentValue(
	db: DbQueryClient,
	e: PersonalAgentEnrollment,
	start: string,
	end: string,
) {
	const [row] = await db.all<{
		findings: number;
		decisionFindings: number;
		decisionCards: number;
		fyiFindings: number;
		decidedFromCard: number;
		outcomes: number;
		verifiedOutcomes: number;
		corroboratedOutcomes: number;
		emailsSent: number;
		acknowledgedOutcomes: number;
		agentReportedReminderRetirements: number;
	}>(sql`
		WITH cohort AS (SELECT min(w.id) AS id,
		 json_extract(w.provenance,'$.personalAgentContribution.kind') AS kind FROM work_items w
		 WHERE w.org_id=${e.orgId}
		 AND json_extract(w.provenance,'$.personalAgentContribution.sourceAgentId')=${e.id}
		 AND json_extract(w.provenance,'$.personalAgentContribution.representedUserId')=${e.representedUserId}
		 AND w.created_at>=${start} AND w.created_at<${end}
		 GROUP BY json_extract(w.provenance,'$.personalAgentContribution.externalFindingId')),
		 outcomes AS (SELECT o.* FROM work_events o JOIN cohort c ON c.id=o.work_item_id
		 WHERE o.org_id=${e.orgId} AND o.event_type='personal_agent.outcome_recorded' AND o.occurred_at<${end})
		SELECT (SELECT count(*) FROM cohort) AS findings,
		 (SELECT count(*) FROM cohort WHERE kind='proposal') AS decisionFindings,
		 (SELECT count(*) FROM cohort c WHERE c.kind='proposal' AND EXISTS (SELECT 1 FROM work_interactions i
		 WHERE i.org_id=${e.orgId} AND i.work_item_id=c.id AND i.target_type='user' AND i.target_id=${e.representedUserId}
		 AND json_extract(i.metadata,'$.source')='personal-agent-inbound'
		 AND json_extract(i.metadata,'$.decisionDeck') IS NOT NULL AND i.created_at<${end})) AS decisionCards,
		 (SELECT count(*) FROM cohort WHERE kind='fyi') AS fyiFindings,
		 (SELECT count(*) FROM cohort c WHERE c.kind='proposal' AND EXISTS (
		 SELECT 1 FROM work_interactions i JOIN work_interaction_responses r ON r.org_id=i.org_id AND r.interaction_id=i.id
		 WHERE i.org_id=${e.orgId} AND i.work_item_id=c.id AND r.responder_type='user' AND r.responder_id=${e.representedUserId}
		 AND i.target_type='user' AND i.target_id=${e.representedUserId} AND json_extract(i.metadata,'$.decisionDeck') IS NOT NULL AND i.created_at<${end}
		 AND r.responder_session_id IS NULL AND r.responder_external_session_key IS NULL AND json_extract(r.metadata,'$.actor') IS NULL
		 AND r.response_kind='answer' AND json_extract(i.metadata,'$.source')='personal-agent-inbound'
		 AND coalesce(json_extract(r.metadata,'$.source'),'') NOT IN ('triage-fyi','auto-reply')
		 AND coalesce(json_extract(r.metadata,'$.draftOutcome'),'')<>'auto'
		 AND r.resolves_request=1 AND r.responded_at<${end} AND json_extract(r.metadata,'$.cardAction') IS NOT NULL)) AS decidedFromCard,
		 (SELECT count(*) FROM outcomes) AS outcomes,
		 (SELECT count(*) FROM outcomes WHERE json_extract(payload,'$.execution.state')='verified') AS verifiedOutcomes,
		 (SELECT count(*) FROM outcomes WHERE json_extract(payload,'$.execution.state')='corroborated') AS corroboratedOutcomes,
		 (SELECT count(*) FROM work_events d JOIN outcomes o ON d.id=o.id || ':email'
		 WHERE d.org_id=${e.orgId} AND json_extract(d.payload,'$.status')='sent' AND d.occurred_at<${end}) AS emailsSent,
		 (SELECT count(*) FROM work_events a JOIN outcomes o ON a.id=o.id || ':ack'
		 WHERE a.org_id=${e.orgId} AND a.occurred_at<${end}) AS acknowledgedOutcomes,
		 (SELECT count(DISTINCT json_extract(a.payload,'$.reminderId')) FROM work_events a JOIN outcomes o ON a.id=o.id || ':ack'
		 WHERE a.org_id=${e.orgId} AND a.occurred_at<${end}) AS agentReportedReminderRetirements`);
	return row!;
}
