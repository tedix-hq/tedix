import { DurableObject } from "cloudflare:workers";
import { readStoredRuntimeAdmission } from "./runtime-admission-do";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Historical replay seals forbid Agent/Pi execution on this object forever. */
function holdsHistoricalReplaySeals(storage: Storage): boolean {
	const table = storage.sql
		.exec(
			"SELECT 1 FROM sqlite_master WHERE type='table' AND name='historical_replay_seals'",
		)
		.toArray();
	if (table.length === 0) return false;
	return (
		storage.sql.exec("SELECT 1 FROM historical_replay_seals LIMIT 1").toArray()
			.length > 0
	);
}

/** True when the object must never run Agent or Pi code: not admitted, or sealed. */
export function requiresInertReceiver(storage: Storage, objectId: string) {
	const admission = readStoredRuntimeAdmission(storage, objectId);
	if (admission && admission.state !== "active") return true;
	return holdsHistoricalReplaySeals(storage);
}

/** Storage-preserving receiver for a non-admitted object. No RPC, no lifecycle. */
export class InertRuntimeDO extends DurableObject<Cloudflare.Env> {
	override async fetch(): Promise<Response> {
		return new Response("runtime object is not admitted", { status: 423 });
	}
	override async alarm(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
	}
}
