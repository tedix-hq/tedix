import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type ExternalAgentSession,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { workAttempts } from "../../schema/work-items";
import { ExternalAgentIdentityError } from "./principals";
import {
	diagnoseMutableSession,
	getExternalAgentSession,
} from "./session-state";
import {
	hasActiveExternalAgentSessionWorkAttempt,
	hasExternalAgentSessionWorkAttempt,
} from "./sessions";

export type ExternalAgentKnowledgeCheckpoint = {
	idempotencyKey: string;
	workItemId: string;
	summary: string;
	evidenceRefs: string[];
	artifactRef: string | null;
	recordedAt: string;
};

export type ExternalAgentKnowledgeDisposition =
	| {
			type: "handoff";
			idempotencyKey: string;
			workItemId: string;
			handoffId: string;
			reviewWorkItemId: string;
			stewardTediId: string;
			recordedAt: string;
	  }
	| {
			type: "no_handoff";
			idempotencyKey: string;
			workItemId: string;
			reason: string;
			recordedAt: string;
	  }
	| {
			type: "zero_work";
			idempotencyKey: string;
			reason: string;
			recordedAt: string;
	  };

function knowledgeLifecycle(metadata: Record<string, JsonValue>): {
	checkpoints: ExternalAgentKnowledgeCheckpoint[];
	disposition?: ExternalAgentKnowledgeDisposition;
} {
	const value = metadata.knowledgeLifecycle;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { checkpoints: [] };
	}
	const record = value as Record<string, unknown>;
	return {
		checkpoints: Array.isArray(record.checkpoints)
			? (record.checkpoints as ExternalAgentKnowledgeCheckpoint[])
			: [],
		...(record.disposition &&
		typeof record.disposition === "object" &&
		!Array.isArray(record.disposition)
			? {
					disposition: record.disposition as ExternalAgentKnowledgeDisposition,
				}
			: {}),
	};
}

export async function recordExternalAgentKnowledgeCheckpoint(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		checkpoint: ExternalAgentKnowledgeCheckpoint;
	},
): Promise<ExternalAgentKnowledgeCheckpoint> {
	const session = await getExternalAgentSession(db, params);
	if (session?.status !== "active") {
		return diagnoseMutableSession(db, params);
	}
	const lifecycle = knowledgeLifecycle(session.metadata);
	const existing = lifecycle.checkpoints.find(
		(item) => item.idempotencyKey === params.checkpoint.idempotencyKey,
	);
	if (existing) {
		const { recordedAt: _existingAt, ...existingContent } = existing;
		const { recordedAt: _requestedAt, ...requestedContent } = params.checkpoint;
		if (JSON.stringify(existingContent) !== JSON.stringify(requestedContent)) {
			throw new ExternalAgentIdentityError(
				"knowledge_disposition_conflict",
				"Knowledge checkpoint idempotency key was reused with different content",
			);
		}
		return existing;
	}
	const checkpoints = [...lifecycle.checkpoints, params.checkpoint].slice(-20);
	const updated = await db
		.update(externalAgentSessions)
		.set({
			lastSeenAt: params.checkpoint.recordedAt,
			metadata: {
				...session.metadata,
				knowledgeLifecycle: { ...lifecycle, checkpoints },
			},
		})
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.principalId, params.principalId),
				eq(externalAgentSessions.id, params.sessionId),
				eq(externalAgentSessions.status, "active"),
				eq(externalAgentSessions.metadata, session.metadata),
			),
		)
		.returning({ id: externalAgentSessions.id });
	if (!updated[0]) {
		return recordExternalAgentKnowledgeCheckpoint(db, params);
	}
	return params.checkpoint;
}

export async function recordExternalAgentKnowledgeDisposition(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		disposition: ExternalAgentKnowledgeDisposition;
	},
): Promise<ExternalAgentKnowledgeDisposition> {
	const session = await getExternalAgentSession(db, params);
	if (session?.status !== "active") {
		return diagnoseMutableSession(db, params);
	}
	const lifecycle = knowledgeLifecycle(session.metadata);
	if (lifecycle.disposition) {
		const { recordedAt: _existingAt, ...existingContent } =
			lifecycle.disposition;
		const { recordedAt: _requestedAt, ...requestedContent } =
			params.disposition;
		if (JSON.stringify(existingContent) !== JSON.stringify(requestedContent)) {
			throw new ExternalAgentIdentityError(
				"knowledge_disposition_conflict",
				"External Agent-Session already has a different knowledge disposition",
			);
		}
		return lifecycle.disposition;
	}
	const updated = await db
		.update(externalAgentSessions)
		.set({
			lastSeenAt: params.disposition.recordedAt,
			metadata: {
				...session.metadata,
				knowledgeLifecycle: { ...lifecycle, disposition: params.disposition },
			},
		})
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.principalId, params.principalId),
				eq(externalAgentSessions.id, params.sessionId),
				eq(externalAgentSessions.status, "active"),
				eq(externalAgentSessions.metadata, session.metadata),
			),
		)
		.returning({ id: externalAgentSessions.id });
	if (!updated[0]) {
		return recordExternalAgentKnowledgeDisposition(db, params);
	}
	return params.disposition;
}

export async function endExternalAgentSession(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		endedAt: string;
		zeroWorkDisposition?: {
			idempotencyKey: string;
			reason: string;
		};
	},
): Promise<ExternalAgentSession> {
	const session = await getExternalAgentSession(db, params);
	const lifecycle = session ? knowledgeLifecycle(session.metadata) : null;
	if (params.zeroWorkDisposition) {
		const requested = {
			type: "zero_work" as const,
			idempotencyKey: params.zeroWorkDisposition.idempotencyKey,
			reason: params.zeroWorkDisposition.reason,
			recordedAt: params.endedAt,
		};
		if (session?.status === "ended") {
			const existing = lifecycle?.disposition;
			if (
				existing?.type === "zero_work" &&
				existing.idempotencyKey === requested.idempotencyKey &&
				existing.reason === requested.reason
			) {
				return session;
			}
			throw new ExternalAgentIdentityError(
				"knowledge_disposition_conflict",
				"Ended external Agent-Session has a different knowledge disposition",
			);
		}
		if (
			session?.status === "active" &&
			(lifecycle?.disposition || lifecycle?.checkpoints.length)
		) {
			throw new ExternalAgentIdentityError(
				"knowledge_disposition_conflict",
				"Zero-work close requires a session with no checkpoint or final disposition",
			);
		}
		if (!session) {
			return diagnoseMutableSession(db, params, {
				requireActivePrincipal: false,
			});
		}
		const rows = await db
			.update(externalAgentSessions)
			.set({
				status: "ended",
				lastSeenAt: params.endedAt,
				endedAt: params.endedAt,
				metadata: {
					...session.metadata,
					knowledgeLifecycle: { ...lifecycle, disposition: requested },
				},
			})
			.where(
				and(
					eq(externalAgentSessions.organizationId, params.organizationId),
					eq(externalAgentSessions.principalId, params.principalId),
					eq(externalAgentSessions.id, params.sessionId),
					eq(externalAgentSessions.status, "active"),
					eq(externalAgentSessions.metadata, session.metadata),
					sql`NOT EXISTS (
						SELECT 1 FROM ${workAttempts} AS session_attempt
						WHERE session_attempt.org_id = ${params.organizationId}
							AND session_attempt.executor_type = 'external_agent'
							AND session_attempt.executor_id = ${params.principalId}
							AND session_attempt.executor_session_id = ${params.sessionId}
					)`,
				),
			)
			.returning();
		if (rows[0]) return rows[0];
		if (
			await hasExternalAgentSessionWorkAttempt(db, {
				organizationId: params.organizationId,
				principalId: params.principalId,
				sessionId: params.sessionId,
			})
		) {
			throw new ExternalAgentIdentityError(
				"knowledge_disposition_conflict",
				"Zero-work close is invalid after the session has owned a Work Item attempt",
			);
		}
		return endExternalAgentSession(db, params);
	}
	if (session?.status === "active" && !lifecycle?.disposition) {
		throw new ExternalAgentIdentityError(
			"knowledge_disposition_required",
			"External Agent-Session cannot end until it records a handoff, explicit no-handoff, or atomic zero-work disposition",
		);
	}
	const activeAttempts = await db
		.select({ id: workAttempts.id })
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, params.organizationId),
				eq(workAttempts.executorType, "external_agent"),
				eq(workAttempts.executorId, params.principalId),
				eq(workAttempts.executorSessionId, params.sessionId),
				inArray(workAttempts.runtimeState, [
					"queued",
					"running",
					"waiting",
					"retrying",
				]),
			),
		)
		.limit(1);
	if (activeAttempts[0]) {
		throw new ExternalAgentIdentityError(
			"active_work_item_attempt",
			"External Agent-Session cannot end while it owns an active Work Item attempt",
		);
	}
	const rows = await db
		.update(externalAgentSessions)
		.set({
			status: "ended",
			lastSeenAt: params.endedAt,
			endedAt: params.endedAt,
		})
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.principalId, params.principalId),
				eq(externalAgentSessions.id, params.sessionId),
				eq(externalAgentSessions.status, "active"),
			),
		)
		.returning();
	if (!rows[0]) {
		return diagnoseMutableSession(db, params, {
			requireActivePrincipal: false,
		});
	}
	return rows[0];
}

export async function listStaleExternalAgentKnowledgeSessions(
	db: DbClient,
	params: {
		organizationId: string;
		staleBefore: string;
		limit: number;
	},
): Promise<ExternalAgentSession[]> {
	const rows = await db
		.select()
		.from(externalAgentSessions)
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.status, "active"),
				sql`${externalAgentSessions.lastSeenAt} < ${params.staleBefore}`,
			),
		)
		.orderBy(externalAgentSessions.lastSeenAt)
		.limit(params.limit);
	return rows.filter(
		(session) => !knowledgeLifecycle(session.metadata).disposition,
	);
}
