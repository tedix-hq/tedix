import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	personalAgentClientRates,
	personalAgentSessions,
} from "../schema/personal-agent-sessions";

interface PersonalAgentSessionParams {
	organizationId: string;
	clientId: string;
	sessionId: string;
	userId: string;
	agentId?: string;
	version: string;
	now: number;
}

function sessionWhere(
	p: Pick<
		PersonalAgentSessionParams,
		"organizationId" | "clientId" | "sessionId" | "userId"
	>,
) {
	return and(
		eq(personalAgentSessions.organizationId, p.organizationId),
		eq(personalAgentSessions.clientId, p.clientId),
		eq(personalAgentSessions.sessionId, p.sessionId),
		eq(personalAgentSessions.userId, p.userId),
	);
}

/** Atomic per-client rate accounting remains effective across isolates and sids. */
export async function consumePersonalAgentClientRate(
	db: DbQueryClient,
	p: { organizationId: string; clientId: string; now: number; limit: number },
) {
	const windowStart = Math.floor(p.now / 60_000) * 60_000;
	const [row] = await db
		.insert(personalAgentClientRates)
		.values({
			organizationId: p.organizationId,
			clientId: p.clientId,
			windowStart,
			requests: 1,
		})
		.onConflictDoUpdate({
			target: [
				personalAgentClientRates.organizationId,
				personalAgentClientRates.clientId,
			],
			set: {
				windowStart,
				requests: sql`CASE WHEN ${personalAgentClientRates.windowStart} = ${windowStart} THEN ${personalAgentClientRates.requests} + 1 ELSE 1 END`,
			},
		})
		.returning({ requests: personalAgentClientRates.requests });
	return Boolean(row && row.requests <= p.limit);
}

/** An insert racing an end must never resurrect the Session. */
export async function continuePersonalAgentSession(
	db: DbQueryClient,
	p: PersonalAgentSessionParams,
) {
	const [created, rows] = await db.batch([
		db
			.insert(personalAgentSessions)
			.values({
				organizationId: p.organizationId,
				clientId: p.clientId,
				sessionId: p.sessionId,
				userId: p.userId,
				agentId: p.agentId ?? null,
				version: p.version,
				createdAt: p.now,
			})
			.onConflictDoNothing()
			.returning({ sessionId: personalAgentSessions.sessionId }),
		db.select().from(personalAgentSessions).where(sessionWhere(p)).limit(1),
	]);
	const row = rows[0];
	if (!row || row.endedAt !== null) return "session_ended" as const;
	if (row.agentId !== (p.agentId ?? null) || row.version !== p.version)
		return "invalid_session" as const;
	return created.length > 0 ? ("started" as const) : ("accepted" as const);
}

export async function endPersonalAgentSession(
	db: DbQueryClient,
	p: Pick<
		PersonalAgentSessionParams,
		"organizationId" | "clientId" | "sessionId" | "userId" | "now"
	>,
) {
	await db
		.update(personalAgentSessions)
		.set({ endedAt: p.now })
		.where(sessionWhere(p));
}
