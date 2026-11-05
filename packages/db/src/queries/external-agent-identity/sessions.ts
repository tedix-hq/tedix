import { withTransientD1ReadRetry } from "../../utils/d1-retry";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, exists, inArray, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import type { DbQueryClient } from "../../query-client";
import {
	type ExternalAgentPrincipal,
	type ExternalAgentSession,
	externalAgentPrincipals,
	externalAgentSessions,
	externalAgentExchangeLimits,
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
		/** Force a session out of corroboration credit (owner-asserted hosts). */
		creditEligible?: false;
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

	const creditEligible =
		input.identitySource !== "derived" && input.creditEligible !== false;
	const metadata = input.metadata ?? {};
	const activePrincipal = alias(externalAgentPrincipals, "active_principal");
	const inserted = await db
		.insert(externalAgentSessions)
		.select(
			db
				.select({
					id: sql<string>`${input.id}`.as("id"),
					organizationId: sql<string>`${input.organizationId}`.as(
						"organization_id",
					),
					principalId: sql<string>`${input.principalId}`.as("principal_id"),
					externalSessionKey: sql<string>`${input.externalSessionKey}`.as(
						"external_session_key",
					),
					harness: sql<string>`${input.harness}`.as("harness"),
					harnessVersion: sql<string>`${input.harnessVersion}`.as(
						"harness_version",
					),
					modelProvider: sql<string>`${input.modelProvider}`.as(
						"model_provider",
					),
					modelId: sql<string>`${input.modelId}`.as("model_id"),
					modelVersion: sql<string>`${input.modelVersion}`.as("model_version"),
					identitySource: sql<
						typeof input.identitySource
					>`${input.identitySource}`.as("identity_source"),
					status: sql<"active">`'active'`.as("status"),
					creditEligible: sql<boolean>`${creditEligible ? 1 : 0}`.as(
						"credit_eligible",
					),
					startedAt: sql<string>`${input.startedAt}`.as("started_at"),
					lastSeenAt: sql<string>`${input.startedAt}`.as("last_seen_at"),
					endedAt: sql<null>`NULL`.as("ended_at"),
					metadata: sql<
						Record<string, JsonValue>
					>`${JSON.stringify(metadata)}`.as("metadata"),
				})
				.from(activePrincipal)
				.where(
					and(
						eq(activePrincipal.organizationId, input.organizationId),
						eq(activePrincipal.id, input.principalId),
						eq(activePrincipal.status, "active"),
					),
				),
		)
		.onConflictDoNothing()
		.returning({ id: externalAgentSessions.id });
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
	const activePrincipal = alias(externalAgentPrincipals, "active_principal");
	const updated = await db
		.update(externalAgentSessions)
		.set({ lastSeenAt: params.seenAt })
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				eq(externalAgentSessions.principalId, params.principalId),
				eq(externalAgentSessions.id, params.sessionId),
				eq(externalAgentSessions.status, "active"),
				exists(
					db
						.select({ one: sql`1` })
						.from(activePrincipal)
						.where(
							and(
								eq(activePrincipal.organizationId, params.organizationId),
								eq(activePrincipal.id, params.principalId),
								eq(activePrincipal.status, "active"),
							),
						),
				),
			),
		)
		.returning({ id: externalAgentSessions.id });
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

/**
 * External session keys of the given principals, newest first — the values
 * journal callers stamp as `threadId`/`agentSession`. Ended sessions count:
 * their recorded decisions remain theirs.
 */
export async function listExternalAgentSessionKeys(
	db: DbQueryClient,
	params: { organizationId: string; principalIds: string[]; limit?: number },
): Promise<string[]> {
	if (params.principalIds.length === 0) return [];
	const rows = await db
		.select({ key: externalAgentSessions.externalSessionKey })
		.from(externalAgentSessions)
		.where(
			and(
				eq(externalAgentSessions.organizationId, params.organizationId),
				// bound-params: callers cap principal ids at 50
				inArray(
					externalAgentSessions.principalId,
					params.principalIds.slice(0, 50),
				),
			),
		)
		.orderBy(desc(externalAgentSessions.startedAt))
		.limit(Math.min(Math.max(params.limit ?? 100, 1), 100));
	return rows.map((row) => row.key);
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

/** A single conditional upsert enforces the UTC minute budget across sessions and isolates. */
export async function consumeExternalAgentExchangeBudget(
	db: DbClient,
	params: { organizationId: string; principalId: string; nowMs: number },
): Promise<boolean> {
	const windowStart = Math.floor(params.nowMs / 60_000);
	const limits = externalAgentExchangeLimits;
	const rows = await db
		.insert(limits)
		.values({
			organizationId: params.organizationId,
			principalId: params.principalId,
			windowStart,
			requestCount: 1,
		})
		.onConflictDoUpdate({
			target: [limits.organizationId, limits.principalId],
			set: {
				windowStart: sql`excluded.window_start`,
				requestCount: sql`CASE WHEN ${limits.windowStart} = excluded.window_start
				THEN ${limits.requestCount} + 1 ELSE 1 END`,
			},
			setWhere: or(
				sql`${limits.windowStart} < excluded.window_start`,
				and(
					sql`${limits.windowStart} = excluded.window_start`,
					lt(limits.requestCount, 30),
				),
			),
		})
		.returning({ requestCount: limits.requestCount });
	return rows.length === 1;
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
