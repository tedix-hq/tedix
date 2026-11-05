import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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
	const activeSession = alias(externalAgentSessions, "active_session");
	const activePrincipal = alias(externalAgentPrincipals, "active_principal");
	const historical = input.allowHistoricalSession ? 1 : 0;
	const inserted = await db
		.insert(externalAgentAttributions)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					principalId: sql<string>`${input.principalId}`.as("principal_id"),
					sessionId: sql<string>`${input.sessionId}`.as("session_id"),
					targetType: sql<typeof input.targetType>`${input.targetType}`.as(
						"target_type",
					),
					targetId: sql<string>`${input.targetId}`.as("target_id"),
					role: sql<typeof input.role>`${input.role}`.as("role"),
					workItemId: sql<string | null>`${workItemId}`.as("work_item_id"),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(metadata)}`.as("metadata"),
					occurredAt: sql<string>`${input.occurredAt}`.as("occurred_at"),
				})
				.from(activeSession)
				.innerJoin(
					activePrincipal,
					and(
						eq(activePrincipal.organizationId, activeSession.organizationId),
						eq(activePrincipal.id, activeSession.principalId),
					),
				)
				.where(
					and(
						eq(activeSession.organizationId, input.organizationId),
						eq(activeSession.principalId, input.principalId),
						eq(activeSession.id, input.sessionId),
						lte(activeSession.startedAt, input.occurredAt),
						// A historical acceptance may attribute an event that happened AFTER the
						// session ended. The bound below only constrains parties who report their
						// true clock: for a commit, occurredAt is the git committer date, which
						// the committer sets (GIT_COMMITTER_DATE). It therefore taxed honest
						// agents and stopped nobody — the dominant cause of human overrides was
						// an agent whose session ended (or whose lease the reaper reclaimed)
						// before CI validated its already-pushed commits.
						or(
							sql`${historical} = 1`,
							isNull(activeSession.endedAt),
							gte(activeSession.endedAt, input.occurredAt),
						),
						// The session's own ended/active state is forgivable; a REVOKED principal
						// is not. allowHistoricalSession used to bypass both, which meant
						// disabling a principal did not stop its pending attributions:
						// setExternalAgentPrincipalStatus bulk-ends that principal's sessions
						// (principals.ts, the non-active branch), so every one of
						// them became "historical" and sailed through this predicate.
						eq(activePrincipal.status, "active"),
						or(sql`${historical} = 1`, eq(activeSession.status, "active")),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: externalAgentAttributions.id });
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
