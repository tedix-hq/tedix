/**
 * Reads and writes of one browser session's refresh-rotation state
 * (`session-rotation-store/schema.ts`). Only fingerprints are stored.
 */
import { eq } from "drizzle-orm";
import type { SessionRotationStoreDb } from "../../session-rotation-store/store";
import {
	logoutReplayFingerprints,
	refreshRotationState,
} from "../../session-rotation-store/schema";

export type RefreshRotationState = Pick<
	typeof refreshRotationState.$inferSelect,
	"generation" | "currentFingerprint" | "status"
>;

export function readRefreshRotationState(
	db: SessionRotationStoreDb,
): RefreshRotationState | null {
	return (
		db
			.select({
				generation: refreshRotationState.generation,
				currentFingerprint: refreshRotationState.currentFingerprint,
				status: refreshRotationState.status,
			})
			.from(refreshRotationState)
			.where(eq(refreshRotationState.singleton, 1))
			.get() ?? null
	);
}

export function writeRefreshRotationState(
	db: SessionRotationStoreDb,
	state: RefreshRotationState & { nowMs: number },
): void {
	const values = {
		generation: state.generation,
		currentFingerprint: state.currentFingerprint,
		status: state.status,
		updatedAt: state.nowMs,
	};
	db.insert(refreshRotationState)
		.values({ singleton: 1, ...values })
		.onConflictDoUpdate({ target: refreshRotationState.singleton, set: values })
		.run();
}

export function isLogoutReplay(
	db: SessionRotationStoreDb,
	fingerprint: string,
): boolean {
	return (
		db
			.select({ fingerprint: logoutReplayFingerprints.fingerprint })
			.from(logoutReplayFingerprints)
			.where(eq(logoutReplayFingerprints.fingerprint, fingerprint))
			.get() !== undefined
	);
}

export function recordLogoutReplay(
	db: SessionRotationStoreDb,
	p: { fingerprint: string; nowMs: number },
): void {
	db.insert(logoutReplayFingerprints)
		.values({ fingerprint: p.fingerprint, loggedOutAt: p.nowMs })
		.onConflictDoUpdate({
			target: logoutReplayFingerprints.fingerprint,
			set: { loggedOutAt: p.nowMs },
		})
		.run();
}
