import { withTransientD1ReadRetry } from "../../utils/d1-retry";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type ExternalAgentPrincipal,
	type ExternalAgentSession,
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { workAttempts } from "../../schema/work-items";
import {
	ExternalAgentIdentityError,
	getExternalAgentPrincipal,
} from "./principals";
import {
	diagnoseMutableSession,
	getExternalAgentSession,
} from "./session-state";

function sameImmutableSession(
	existing: ExternalAgentSession,
	input: {
		principalId: string;
		harness: string;
		harnessVersion: string;
		modelProvider: string;
		modelId: string;
		modelVersion: string;
		identitySource: "native" | "explicit" | "derived";
	},
): boolean {
	return (
		existing.principalId === input.principalId &&
		existing.harness === input.harness &&
		existing.harnessVersion === input.harnessVersion &&
		existing.modelProvider === input.modelProvider &&
		existing.modelId === input.modelId &&
		existing.modelVersion === input.modelVersion &&
		existing.identitySource === input.identitySource
	);
}

export async function openExternalAgentSession(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		principalId: string;
		externalSessionKey: string;
		harness: string;
		harnessVersion: string;
		modelProvider: string;
		modelId: string;
		modelVersion: string;
		identitySource: "native" | "explicit" | "derived";
		metadata?: Record<string, JsonValue>;
		startedAt: string;
	},
): Promise<ExternalAgentSession> {
	// Reopening an immutable session is a read, not a write. Avoid sending
	// every CLI invocation through the D1 primary write queue. The insert below
	// still arbitrates concurrent first opens; all replays recheck the principal.
	async function findExistingSession() {
		const rows = await withTransientD1ReadRetry(
			"external_agent.existing_session",
			async () =>
				db
					.select()
					.from(externalAgentSessions)
					.where(
						and(
							eq(externalAgentSessions.organizationId, input.organizationId),
							eq(externalAgentSessions.harness, input.harness),
							eq(
								externalAgentSessions.externalSessionKey,
								input.externalSessionKey,
							),
						),
					)
					.limit(1),
			{ timeoutMs: 5_000 },
		);
		return rows[0];
	}
	async function validateExistingSession(
		existing: ExternalAgentSession | undefined,
	) {
		const principal = await getExternalAgentPrincipal(db, input);
		if (!principal) {
			throw new ExternalAgentIdentityError(
				"principal_not_found",
				"External-agent principal not found",
			);
		}
		if (principal.status !== "active") {
			throw new ExternalAgentIdentityError(
				"principal_inactive",
				`External-agent principal is ${principal.status}`,
			);
		}
		if (!existing || !sameImmutableSession(existing, input)) {
			throw new ExternalAgentIdentityError(
				"immutable_session_conflict",
				"External Agent-Session is already bound to a different principal, harness, or model tuple",
			);
		}
		if (existing.status !== "active") {
			throw new ExternalAgentIdentityError(
				"session_ended",
				"External Agent-Session has ended and cannot be reopened",
			);
		}
		return existing;
	}
	const existing = await findExistingSession();
	if (existing) return validateExistingSession(existing);

	const creditEligible = input.identitySource !== "derived";
	const metadata = input.metadata ?? {};
	const inserted = (await db.all(sql`
		INSERT INTO ${externalAgentSessions} (
			id, organization_id, principal_id, external_session_key,
			harness, harness_version, model_provider, model_id, model_version,
			identity_source, status, credit_eligible, started_at, last_seen_at,
			ended_at, metadata
		)
		SELECT
			${input.id}, ${input.organizationId}, ${input.principalId},
			${input.externalSessionKey}, ${input.harness}, ${input.harnessVersion},
			${input.modelProvider}, ${input.modelId}, ${input.modelVersion},
			${input.identitySource}, 'active', ${creditEligible ? 1 : 0},
			${input.startedAt}, ${input.startedAt}, NULL, ${JSON.stringify(metadata)}
		FROM ${externalAgentPrincipals} AS active_principal
		WHERE active_principal.organization_id = ${input.organizationId}
			AND active_principal.id = ${input.principalId}
			AND active_principal.status = 'active'
		ON CONFLICT DO NOTHING
		RETURNING id
	`)) as Array<{ id: string }>;
	if (inserted[0]) {
		const created = await getExternalAgentSession(db, {
			organizationId: input.organizationId,
			principalId: input.principalId,
			sessionId: inserted[0].id,
		});
		if (created) return created;
	}

	return validateExistingSession(await findExistingSession());
}

export async function heartbeatExternalAgentSession(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
		seenAt: string;
	},
): Promise<ExternalAgentSession> {
	const updated = (await db.all(sql`
		UPDATE ${externalAgentSessions}
		SET last_seen_at = ${params.seenAt}
		WHERE organization_id = ${params.organizationId}
			AND principal_id = ${params.principalId}
			AND id = ${params.sessionId}
			AND status = 'active'
			AND EXISTS (
				SELECT 1 FROM ${externalAgentPrincipals} AS active_principal
				WHERE active_principal.organization_id = ${params.organizationId}
					AND active_principal.id = ${params.principalId}
					AND active_principal.status = 'active'
			)
		RETURNING id
	`)) as Array<{ id: string }>;
	if (!updated[0]) return diagnoseMutableSession(db, params);
	return (await getExternalAgentSession(db, params))!;
}

export async function hasExternalAgentWorkAttempt(
	db: DbClient,
	params: {
		organizationId: string;
		workItemId: string;
		principalId: string;
		sessionId: string;
	},
): Promise<boolean> {
	const rows = await db
		.select({ id: workAttempts.id })
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.workItemId, params.workItemId),
				eq(workAttempts.orgId, params.organizationId),
				eq(workAttempts.executorType, "external_agent"),
				eq(workAttempts.executorId, params.principalId),
				eq(workAttempts.executorSessionId, params.sessionId),
			),
		)
		.limit(1);
	return rows[0] !== undefined;
}

export async function hasExternalAgentSessionWorkAttempt(
	db: DbClient,
	params: { organizationId: string; principalId: string; sessionId: string },
): Promise<boolean> {
	const rows = await db
		.select({ id: workAttempts.id })
		.from(workAttempts)
		.where(
			and(
				eq(workAttempts.orgId, params.organizationId),
				eq(workAttempts.executorType, "external_agent"),
				eq(workAttempts.executorId, params.principalId),
				eq(workAttempts.executorSessionId, params.sessionId),
			),
		)
		.limit(1);
	return rows[0] !== undefined;
}

export async function hasActiveExternalAgentSessionWorkAttempt(
	db: DbClient,
	params: {
		organizationId: string;
		principalId: string;
		sessionId: string;
	},
): Promise<boolean> {
	const rows = await db
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
	return rows[0] !== undefined;
}

export async function listExternalAgentSessions(
	db: DbClient,
	params: { organizationId: string; principalId: string; limit?: number },
): Promise<ExternalAgentSession[]> {
	return db
		.select()
		.from(externalAgentSessions)
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.principalId, params.principalId),
			),
		)
		.orderBy(desc(externalAgentSessions.startedAt))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 500));
}

export async function resolveActiveExternalAgentSession(
	db: DbClient,
	params: { organizationId: string; principalId: string; sessionId: string },
): Promise<{
	principal: ExternalAgentPrincipal;
	session: ExternalAgentSession;
} | null> {
	const row = await db.query.externalAgentSessions.findFirst({
		where: {
			organizationId: params.organizationId,
			principalId: params.principalId,
			id: params.sessionId,
			status: "active",
			principal: { status: "active" },
		},
		with: { principal: true },
	});
	if (!row?.principal) return null;

	const { principal, ...session } = row;
	return { principal, session };
}

/** Narrow immutable-session lookup for attempt fencing and Git attribution. */
/**
 * Resolve the session behind a Git-provenance claim, with its principal's
 * current status so the caller can refuse a REVOKED credential by name.
 *
 * Revocation is the boundary that replaced the old committer-date upper bounds,
 * and this is the one chokepoint both remaining provenance paths share (the
 * settled receipt and the active attempt) — putting it here avoids a third copy
 * of a predicate this subsystem has already had trouble keeping consistent.
 *
 * The session's own ended state is deliberately NOT filtered: an ended session
 * still authored its commits, and the caller decides how to treat the window.
 */
