/**
 * Reads and writes of a single-use session intent's one row
 * (`session-intent-store/schema.ts`). Each state change is guarded on the
 * status it leaves and reports whether it changed the row, so a code or
 * outbound handoff is consumed at most once.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { SessionIntentStoreDb } from "../../session-intent-store/store";
import { sessionIntent } from "../../session-intent-store/schema";

export type SessionIntentRow = typeof sessionIntent.$inferSelect;

const only = eq(sessionIntent.singleton, 1);

/** Clears every credential and code a grant carried. */
const clearedGrant = {
	codeHash: null,
	codeExpiresAt: null,
	grantKind: null,
	grantedTenantId: null,
	sessionJwt: null,
	subject: null,
	sessionExpiresAt: null,
} as const;

export function readSessionIntent(
	db: SessionIntentStoreDb,
): SessionIntentRow | null {
	return db.select().from(sessionIntent).where(only).get() ?? null;
}

export function insertPendingSessionIntent(
	db: SessionIntentStoreDb,
	p: { intentJson: string; nowMs: number },
): void {
	db.insert(sessionIntent)
		.values({
			singleton: 1,
			intentJson: p.intentJson,
			status: "pending",
			updatedAt: p.nowMs,
		})
		.run();
}

function changedOne(rows: unknown[]): boolean {
	return rows.length === 1;
}

/** Reserve the pending intent's one interactive reauthentication. */
export function beginSessionIntentReauthentication(
	db: SessionIntentStoreDb,
	nowMs: number,
): boolean {
	return changedOne(
		db
			.update(sessionIntent)
			.set({ reauthStartedAt: nowMs, updatedAt: nowMs })
			.where(
				and(
					only,
					eq(sessionIntent.status, "pending"),
					isNull(sessionIntent.reauthStartedAt),
				),
			)
			.returning({ singleton: sessionIntent.singleton })
			.all(),
	);
}

/** Consume a pending intent (a completed outbound handoff). */
export function consumePendingSessionIntent(
	db: SessionIntentStoreDb,
	nowMs: number,
): boolean {
	return changedOne(
		db
			.update(sessionIntent)
			.set({ status: "consumed", updatedAt: nowMs })
			.where(and(only, eq(sessionIntent.status, "pending")))
			.returning({ singleton: sessionIntent.singleton })
			.all(),
	);
}

export function grantSessionIntentSession(
	db: SessionIntentStoreDb,
	p: {
		codeHash: string;
		codeExpiresAt: number;
		tenantId: string | null;
		sessionJwt: string;
		subject: string;
		sessionExpiresAt: number;
		nowMs: number;
	},
): boolean {
	return changedOne(
		db
			.update(sessionIntent)
			.set({
				status: "granted",
				codeHash: p.codeHash,
				codeExpiresAt: p.codeExpiresAt,
				grantKind: "session",
				grantedTenantId: p.tenantId,
				sessionJwt: p.sessionJwt,
				subject: p.subject,
				sessionExpiresAt: p.sessionExpiresAt,
				updatedAt: p.nowMs,
			})
			.where(and(only, eq(sessionIntent.status, "pending")))
			.returning({ singleton: sessionIntent.singleton })
			.all(),
	);
}

export function grantSessionIntentLogout(
	db: SessionIntentStoreDb,
	p: { codeHash: string; codeExpiresAt: number; nowMs: number },
): boolean {
	return changedOne(
		db
			.update(sessionIntent)
			.set({
				...clearedGrant,
				status: "granted",
				codeHash: p.codeHash,
				codeExpiresAt: p.codeExpiresAt,
				grantKind: "logout",
				updatedAt: p.nowMs,
			})
			.where(and(only, eq(sessionIntent.status, "pending")))
			.returning({ singleton: sessionIntent.singleton })
			.all(),
	);
}

/** Fail a pending or granted intent and drop whatever it was granted. */
export function failSessionIntent(
	db: SessionIntentStoreDb,
	nowMs: number,
): void {
	db.update(sessionIntent)
		.set({ ...clearedGrant, status: "failed", updatedAt: nowMs })
		.where(and(only, inArray(sessionIntent.status, ["pending", "granted"])))
		.run();
}

/** Consume a granted intent for exactly this code, dropping its credentials. */
export function consumeGrantedSessionIntent(
	db: SessionIntentStoreDb,
	p: { codeHash: string; nowMs: number },
): boolean {
	return changedOne(
		db
			.update(sessionIntent)
			.set({ ...clearedGrant, status: "consumed", updatedAt: p.nowMs })
			.where(
				and(
					only,
					eq(sessionIntent.status, "granted"),
					eq(sessionIntent.codeHash, p.codeHash),
				),
			)
			.returning({ singleton: sessionIntent.singleton })
			.all(),
	);
}
