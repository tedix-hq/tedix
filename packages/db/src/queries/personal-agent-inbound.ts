import type {
	PersonalAgentContribution,
	PersonalAgentEnrollment,
	PersonalAgentFinding,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { getWorkItemBySourceIntentId } from "./work-items/crud";

export const PERSONAL_AGENT_NAMESPACE = "personal-agent-inbound.v1";
export function personalAgentConfigKey(orgId: string, id: string) {
	return `${orgId}:${id}`;
}

/** The config revision fences revocation and the unique Work source intent fences retries. */
export async function capturePersonalAgentFinding(
	db: DbQueryClient,
	input: {
		enrollment: PersonalAgentEnrollment;
		revision: number;
		finding: PersonalAgentFinding;
		contribution: PersonalAgentContribution;
		sourceIntentId: string;
	},
) {
	const { enrollment: e, finding: f, contribution: c } = input;
	const id = crypto.randomUUID();
	const provenance = JSON.stringify({ personalAgentContribution: c });
	await db.batch([
		db.run(sql`INSERT INTO work_items
			(id, org_id, title, description, work_kind, disposition, risk_level,
			accountable_owner_type, accountable_owner_id, project_id, objective_id,
			work_class, source_intent_id, provenance, metadata, created_at)
			SELECT ${id}, ${e.orgId}, ${f.title}, ${f.body}, 'research', 'proposed', 'low',
			'user', ${e.representedUserId}, p.id, p.objective_id, 'objective',
			${input.sourceIntentId}, ${provenance}, '{}', ${c.capturedAt}
			FROM user_configs AS cfg JOIN projects AS p ON p.id = ${e.projectId} AND p.org_id = ${e.orgId}
			WHERE cfg.user_id = ${e.representedUserId} AND cfg.namespace = ${PERSONAL_AGENT_NAMESPACE}
			AND cfg.key = ${personalAgentConfigKey(e.orgId, e.id)} AND cfg.revision = ${input.revision}
			AND json_extract(cfg.value, '$.active') = 1 AND p.status = 'active' AND p.objective_id IS NOT NULL
			ON CONFLICT(org_id, source_intent_id) DO NOTHING`),
		db.run(sql`INSERT INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at)
			SELECT ${crypto.randomUUID()}, ${e.orgId}, id, 'personal_agent.finding_received', 'system', ${`personal-agent:${e.id}`},
			${JSON.stringify({ summary: f.title, personalAgentContribution: c })}, ${c.capturedAt}
			FROM work_items WHERE id = ${id} AND org_id = ${e.orgId}`),
	]);
	const work = await getWorkItemBySourceIntentId(db, {
		orgId: e.orgId,
		sourceIntentId: input.sourceIntentId,
	});
	if (!work) return null;
	return { work, duplicate: work.id !== id };
}
