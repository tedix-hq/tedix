import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	tokenExchangeGrants,
	type NewTokenExchangeGrantRow,
	type TokenExchangeGrantRow,
} from "../schema/token-exchange";

export async function insertTokenExchangeGrant(
	db: DbQueryClient,
	row: NewTokenExchangeGrantRow,
): Promise<void> {
	await buildInsertTokenExchangeGrantStatement(db, row);
}

/** Unexecuted lineage insert, for `db.batch()` with its audit row. */
export function buildInsertTokenExchangeGrantStatement(
	db: DbQueryClient,
	row: NewTokenExchangeGrantRow,
) {
	return db.insert(tokenExchangeGrants).values(row);
}

/**
 * Mark one unrevoked, unexpired, unused token in one organization used and
 * return its lineage row. A second use, a revoked or expired token, or a
 * foreign organization or another procedure returns null: each exchanged
 * token admits one call to its own procedure.
 */
export async function consumeTokenExchangeGrant(
	db: DbQueryClient,
	params: {
		jti: string;
		organizationId: string;
		/** The procedure being called; a token for another one is left unused. */
		endpoint: string;
		now: number;
		at: string;
	},
): Promise<TokenExchangeGrantRow | null> {
	const [row] = await db
		.update(tokenExchangeGrants)
		.set({ usedAt: params.at })
		.where(
			and(
				eq(tokenExchangeGrants.jti, params.jti),
				eq(tokenExchangeGrants.organizationId, params.organizationId),
				eq(tokenExchangeGrants.endpoint, params.endpoint),
				isNull(tokenExchangeGrants.usedAt),
				isNull(tokenExchangeGrants.revokedAt),
				gt(tokenExchangeGrants.expiresAt, params.now),
			),
		)
		.returning();
	return row ?? null;
}

/**
 * Revoke one token and every token exchanged from it, within one
 * organization. Returns the revoked ids; an unknown or foreign id revokes
 * nothing.
 */
export async function revokeTokenExchangeLineage(
	db: DbQueryClient,
	params: {
		organizationId: string;
		jti: string;
		revokedBy: string;
		at: string;
	},
): Promise<string[]> {
	const rows = await db
		.update(tokenExchangeGrants)
		.set({ revokedAt: params.at, revokedBy: params.revokedBy })
		.where(
			and(
				eq(tokenExchangeGrants.organizationId, params.organizationId),
				isNull(tokenExchangeGrants.revokedAt),
				sql`${tokenExchangeGrants.jti} IN (WITH RECURSIVE lineage(jti) AS (SELECT jti FROM token_exchange_grants WHERE jti = ${params.jti} AND organization_id = ${params.organizationId} UNION SELECT child.jti FROM token_exchange_grants AS child JOIN lineage ON child.parent_jti = lineage.jti WHERE child.organization_id = ${params.organizationId}) SELECT jti FROM lineage)`,
			),
		)
		.returning({ jti: tokenExchangeGrants.jti });
	return rows.map((row) => row.jti);
}
