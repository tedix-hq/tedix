import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type ExternalAgentAttribution,
	externalAgentAttributions,
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { ExternalAgentIdentityError } from "./principals";
import { diagnoseMutableSession } from "./session-state";

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export async function recordExternalAgentAttribution(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		principalId: string;
		sessionId: string;
		targetType:
			| "work_item_attempt"
			| "work_item_event"
			| "mcp_execution"
			| "commit";
		targetId: string;
		role: "executor";
		workItemId?: string;
		metadata?: Record<string, JsonValue>;
		certificationSource?: "mcp_gateway" | "work_item_attempt";
		occurredAt: string;
		/** Allow an ended immutable session when the event occurred during it. */
		allowHistoricalSession?: boolean;
		/**
		 * Accept an existing attribution for the same (target, principal) key
		 * when it was written by the SAME session, even if it is bound to a
		 * different work item. A commit's executor attribution is one row; a
		 * multi-item commit (several `Work-Item:` trailers) shares it — the
		 * per-item tie lives on each work item's release metadata. Cross-session
		 * conflicts still throw.
		 */
		sharedTargetOk?: boolean;
	},
): Promise<ExternalAgentAttribution> {
	const {
		provenanceCertification: _untrustedCertification,
		...providedMetadata
	} = input.metadata ?? {};
	const metadata = input.certificationSource
		? {
				...providedMetadata,
				provenanceCertification: {
					source: input.certificationSource,
					verifier: "tedix",
				},
			}
		: providedMetadata;
	const workItemId = input.workItemId ?? null;
	const inserted = (await db.all(sql`
		INSERT INTO ${externalAgentAttributions} (
			id, organization_id, principal_id, session_id, target_type,
			target_id, role, work_item_id, metadata, occurred_at
		)
		SELECT
			${input.id}, ${input.organizationId}, ${input.principalId},
			${input.sessionId}, ${input.targetType}, ${input.targetId},
			${input.role}, ${workItemId}, ${JSON.stringify(metadata)},
			${input.occurredAt}
		FROM ${externalAgentSessions} AS active_session
		JOIN ${externalAgentPrincipals} AS active_principal
			ON active_principal.organization_id = active_session.organization_id
			AND active_principal.id = active_session.principal_id
		WHERE active_session.organization_id = ${input.organizationId}
			AND active_session.principal_id = ${input.principalId}
			AND active_session.id = ${input.sessionId}
			AND active_session.started_at <= ${input.occurredAt}
			-- A historical acceptance may attribute an event that happened AFTER the
			-- session ended. The bound below only constrains parties who report their
			-- true clock: for a commit, occurredAt is the git committer date, which
			-- the committer sets (GIT_COMMITTER_DATE). It therefore taxed honest
			-- agents and stopped nobody — the dominant cause of human overrides was
			-- an agent whose session ended (or whose lease the reaper reclaimed)
			-- before CI validated its already-pushed commits.
			AND (
				${input.allowHistoricalSession ? 1 : 0} = 1
				OR active_session.ended_at IS NULL
				OR active_session.ended_at >= ${input.occurredAt}
			)
			-- The session's own ended/active state is forgivable; a REVOKED principal
			-- is not. allowHistoricalSession used to bypass both, which meant
			-- disabling a principal did not stop its pending attributions:
			-- setExternalAgentPrincipalStatus bulk-ends that principal's sessions
			-- (principals.ts, the non-active branch), so every one of
			-- them became "historical" and sailed through this predicate.
			AND active_principal.status = 'active'
			AND (
				${input.allowHistoricalSession ? 1 : 0} = 1
				OR active_session.status = 'active'
			)
		ON CONFLICT DO NOTHING
		RETURNING id
	`)) as Array<{ id: string }>;
	if (inserted[0]) {
		const created = await db
			.select()
			.from(externalAgentAttributions)
			.where(eq(externalAgentAttributions.id, inserted[0].id))
			.limit(1);
		if (created[0]) return created[0];
	}
	const rows = await db
		.select()
		.from(externalAgentAttributions)
		.where(
			and(
				eq(externalAgentAttributions.organizationId, input.organizationId),
				eq(externalAgentAttributions.targetType, input.targetType),
				eq(externalAgentAttributions.targetId, input.targetId),
				eq(externalAgentAttributions.role, input.role),
				eq(externalAgentAttributions.principalId, input.principalId),
			),
		)
		.limit(1);
	const existing = rows[0];
	if (existing) {
		const exactReplay =
			existing.sessionId === input.sessionId &&
			existing.workItemId === workItemId &&
			stableJson(existing.metadata) === stableJson(metadata);
		if (exactReplay) return existing;
		if (input.sharedTargetOk && existing.sessionId === input.sessionId) {
			return existing;
		}
		throw new ExternalAgentIdentityError(
			"immutable_session_conflict",
			"Attribution key is already bound to a different session, work item, or metadata record",
		);
	}
	return diagnoseMutableSession(db, input);
}

export async function resolveExternalAgentAttributionStamp(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		clientRecordId: string;
	},
): Promise<{
	externalSessionKey: string;
	harness: string;
	clientRecordId: string;
} | null> {
	const row = await db.query.externalAgentMcpCredentials.findFirst({
		columns: { clientRecordId: true },
		where: {
			organizationId: params.organizationId,
			principalId: params.principalId,
			sessionId: params.sessionId,
			clientRecordId: params.clientRecordId,
		},
		with: {
			session: { columns: { externalSessionKey: true, harness: true } },
		},
	});
	if (!row?.session) return null;
	return {
		externalSessionKey: row.session.externalSessionKey,
		harness: row.session.harness,
		clientRecordId: row.clientRecordId,
	};
}
