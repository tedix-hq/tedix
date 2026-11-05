/**
 * Per-tedi trusted email recipients: exact addresses a tedi may email without
 * a human approval card. Every read and write is scoped to the owning
 * organization and tedi. Addresses arrive already validated and lowercased by
 * the caller (`normalizeTrustedRecipientAddress`).
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type TediEmailTrustedRecipientRow,
	tediEmailTrustedRecipients,
} from "../../schema/tedi-email";

export interface TediEmailTrustedRecipientScopeParams {
	organizationId: string;
	tediId: string;
}

function scope(params: TediEmailTrustedRecipientScopeParams) {
	return and(
		eq(tediEmailTrustedRecipients.organizationId, params.organizationId),
		eq(tediEmailTrustedRecipients.tediId, params.tediId),
	);
}

/** Unexecuted read of a tedi's active list, for `db.batch()` composition. */
export function buildListActiveTediEmailTrustedRecipientsStatement(
	db: DbQueryClient,
	params: TediEmailTrustedRecipientScopeParams,
) {
	return db
		.select()
		.from(tediEmailTrustedRecipients)
		.where(and(scope(params), isNull(tediEmailTrustedRecipients.revokedAt)))
		.orderBy(
			asc(tediEmailTrustedRecipients.address),
			asc(tediEmailTrustedRecipients.id),
		);
}

export async function listTediEmailTrustedRecipients(
	db: DbQueryClient,
	params: TediEmailTrustedRecipientScopeParams & { includeRevoked?: boolean },
): Promise<TediEmailTrustedRecipientRow[]> {
	if (!params.includeRevoked)
		return buildListActiveTediEmailTrustedRecipientsStatement(db, params);
	return db
		.select()
		.from(tediEmailTrustedRecipients)
		.where(scope(params))
		.orderBy(
			asc(tediEmailTrustedRecipients.address),
			asc(tediEmailTrustedRecipients.createdAt),
			asc(tediEmailTrustedRecipients.id),
		);
}

export interface AddTediEmailTrustedRecipientParams extends TediEmailTrustedRecipientScopeParams {
	address: string;
	createdBy: string;
}

/**
 * Adds an address to the active list. Idempotent: an address that is already
 * active returns the existing row (`created: false`). One batch inserts and
 * reads back, so a concurrent add cannot produce two active rows.
 */
export async function addTediEmailTrustedRecipient(
	db: DbQueryClient,
	params: AddTediEmailTrustedRecipientParams,
): Promise<{ recipient: TediEmailTrustedRecipientRow; created: boolean }> {
	const id = crypto.randomUUID();
	const [, rows] = await db.batch([
		db
			.insert(tediEmailTrustedRecipients)
			.values({
				id,
				organizationId: params.organizationId,
				tediId: params.tediId,
				address: params.address,
				createdBy: params.createdBy,
			})
			.onConflictDoNothing(),
		db
			.select()
			.from(tediEmailTrustedRecipients)
			.where(
				and(
					scope(params),
					eq(tediEmailTrustedRecipients.address, params.address),
					isNull(tediEmailTrustedRecipients.revokedAt),
				),
			)
			.limit(1),
	]);
	const recipient = rows[0];
	if (!recipient)
		throw new Error("Trusted recipient was not stored for this tedi");
	return { recipient, created: recipient.id === id };
}

export interface RevokeTediEmailTrustedRecipientParams extends TediEmailTrustedRecipientScopeParams {
	id: string;
	revokedBy: string;
}

/** Revokes an active row; null when it is absent, revoked, or out of scope. */
export async function revokeTediEmailTrustedRecipient(
	db: DbQueryClient,
	params: RevokeTediEmailTrustedRecipientParams,
): Promise<TediEmailTrustedRecipientRow | null> {
	const rows = await db
		.update(tediEmailTrustedRecipients)
		.set({ revokedAt: new Date().toISOString(), revokedBy: params.revokedBy })
		.where(
			and(
				scope(params),
				eq(tediEmailTrustedRecipients.id, params.id),
				isNull(tediEmailTrustedRecipients.revokedAt),
			),
		)
		.returning();
	return rows[0] ?? null;
}
