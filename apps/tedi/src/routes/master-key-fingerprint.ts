/**
 * Fleet-scoped master-key fingerprint relay.
 *
 * `SECRETS_MASTER_KEY` is set by hand on every Worker that decrypts tedi
 * secrets, and apps/api can only reach apps/tedi-runtime through this edge.
 * This route reports the edge's own key fingerprints and asks the runtime for
 * its own over the service binding, so apps/api can compare the whole fleet
 * without any Worker revealing key material.
 *
 * Mounted before tedi resolution: the answer is per Worker, not per tedi.
 */

import { masterKeyFingerprints } from "@tedix/db/utils/secrets-encryption";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const MASTER_KEY_FINGERPRINT_PATH = "/__internal/master-key-fingerprint";

/** Bound so a wedged runtime cannot hold the fleet check open. */
const RUNTIME_PROBE_TIMEOUT_MS = 3_000;

export interface WorkerMasterKeyFingerprint {
	worker: string;
	/** Window order: index 0 is the key that encrypts. Empty when `error` is set. */
	fingerprints: string[];
	error?: string;
}

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

/** The runtime's answer, or an error entry; never throws. */
async function runtimeMasterKey(
	service: Fetcher | undefined,
): Promise<WorkerMasterKeyFingerprint> {
	const worker = "tedi-runtime";
	if (!service) return { worker, fingerprints: [], error: "unbound" };
	try {
		const response = await service.fetch(
			`http://tedi-runtime${MASTER_KEY_FINGERPRINT_PATH}`,
			{
				headers: { "X-Service-Binding": "true" },
				signal: AbortSignal.timeout(RUNTIME_PROBE_TIMEOUT_MS),
			},
		);
		if (!response.ok) {
			return { worker, fingerprints: [], error: `http_${response.status}` };
		}
		const body: unknown = await response.json();
		return isWorkerFingerprint(body)
			? body
			: { worker, fingerprints: [], error: "malformed_response" };
	} catch (error) {
		return {
			worker,
			fingerprints: [],
			error:
				error instanceof Error && error.name === "TimeoutError"
					? "timeout"
					: "unreachable",
		};
	}
}

const masterKeyFingerprint = new Hono<AppEnv>();

// authz: service binding only. The fingerprints are not secrets, but the
// fleet's key layout is operator information; the caller is apps/api on
// behalf of a platform admin.
masterKeyFingerprint.get(MASTER_KEY_FINGERPRINT_PATH, async (c) => {
	if (!isServiceBinding(c.req.raw.headers)) {
		return c.json({ error: "Not found" }, 404);
	}
	const [self, runtime] = await Promise.all([
		describeMasterKey("tedi", c.env.SECRETS_MASTER_KEY),
		runtimeMasterKey(c.env.TEDI_RUNTIME_SERVICE),
	]);
	return c.json({ workers: [self, runtime] });
});

export { masterKeyFingerprint };
