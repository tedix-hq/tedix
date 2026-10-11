/**
 * Fleet `SECRETS_MASTER_KEY` agreement check.
 *
 * The key is set by hand on every Worker that decrypts secrets. When one copy
 * diverges, that Worker's secrets silently fail to decrypt and nothing short
 * of reading both secrets says which one is wrong. apps/api fingerprints its
 * own window and asks the tedi edge (which relays to the tedi runtime, the only
 * route apps/api has to it) for the rest, then says whether the fleet agrees
 * on the encrypting key. No key material ever leaves a Worker.
 */

import type {
	MasterKeyFingerprintsResponse,
	WorkerMasterKeyFingerprint,
} from "@tedix/api-contract/contracts/secrets";
import { masterKeyFingerprints } from "@tedix/db/utils/secrets-encryption";

/** Bound so one wedged Worker cannot hold an operator read open. */
const FLEET_PROBE_TIMEOUT_MS = 5_000;

const FLEET_FINGERPRINT_URL = "http://tedi/__internal/master-key-fingerprint";

export type MasterKeyFingerprintEnv = {
	SECRETS_MASTER_KEY?: string;
	TEDI_SERVICE?: Pick<Fetcher, "fetch">;
};

/** Fingerprint one Worker's master key value; never throws and never echoes the value. */
export async function describeMasterKey(
	worker: string,
	masterKeyValue: string | undefined,
): Promise<WorkerMasterKeyFingerprint> {
	if (!masterKeyValue) return { worker, fingerprints: [], error: "unset" };
	try {
		return {
			worker,
			fingerprints: await masterKeyFingerprints(masterKeyValue),
		};
	} catch (error) {
		return {
			worker,
			fingerprints: [],
			error: error instanceof Error ? error.message : "malformed",
		};
	}
}

function isWorkerFingerprint(
	value: unknown,
): value is WorkerMasterKeyFingerprint {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.worker === "string" &&
		Array.isArray(record.fingerprints) &&
		record.fingerprints.every((entry) => typeof entry === "string") &&
		(record.error === undefined || typeof record.error === "string")
	);
}

/** The edge's relay answer (itself plus the runtime), or one error entry per Worker it covers. */
async function fleetMasterKeys(
	service: Pick<Fetcher, "fetch"> | undefined,
): Promise<WorkerMasterKeyFingerprint[]> {
	const unreachable = (error: string) =>
		["tedi", "tedi-runtime"].map((worker) => ({
			worker,
			fingerprints: [],
			error,
		}));
	if (!service) return unreachable("unbound");
	try {
		const response = await service.fetch(FLEET_FINGERPRINT_URL, {
			headers: { "X-Service-Binding": "true" },
			signal: AbortSignal.timeout(FLEET_PROBE_TIMEOUT_MS),
		});
		if (!response.ok) return unreachable(`http_${response.status}`);
		const body = (await response.json()) as { workers?: unknown };
		if (
			!Array.isArray(body.workers) ||
			!body.workers.every(isWorkerFingerprint)
		) {
			return unreachable("malformed_response");
		}
		return body.workers;
	} catch (error) {
		return unreachable(
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "unreachable",
		);
	}
}

/** True only when every Worker reported and all agree on the key that encrypts. */
export function masterKeysConsistent(
	workers: readonly WorkerMasterKeyFingerprint[],
): boolean {
	if (workers.length === 0) return false;
	const encrypting = new Set<string>();
	for (const entry of workers) {
		if (entry.error !== undefined || entry.fingerprints.length === 0)
			return false;
		encrypting.add(entry.fingerprints[0]!);
	}
	return encrypting.size === 1;
}

export async function collectMasterKeyFingerprints(
	env: MasterKeyFingerprintEnv,
): Promise<MasterKeyFingerprintsResponse> {
	const [self, fleet] = await Promise.all([
		describeMasterKey("api", env.SECRETS_MASTER_KEY),
		fleetMasterKeys(env.TEDI_SERVICE),
	]);
	const workers = [self, ...fleet];
	return { workers, consistent: masterKeysConsistent(workers) };
}
