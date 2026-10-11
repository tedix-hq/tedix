import { masterKeyFingerprints } from "@tedix/db/utils/secrets-encryption";
import { describe, expect, it } from "vite-plus/test";
import {
	MASTER_KEY_FINGERPRINT_PATH,
	masterKeyFingerprint,
} from "./master-key-fingerprint";

const EDGE_KEY = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const RUNTIME_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

const call = (env: Record<string, unknown>, serviceBinding = true) =>
	masterKeyFingerprint.request(
		MASTER_KEY_FINGERPRINT_PATH,
		{ headers: serviceBinding ? { "X-Service-Binding": "true" } : {} },
		env,
	);

const runtimeService = (body: unknown, status = 200) => ({
	fetch: async (_url: string, init?: RequestInit) => {
		expect(new Headers(init?.headers).get("X-Service-Binding")).toBe("true");
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	},
});

describe("fleet master-key fingerprint relay", () => {
	it("reports the edge and the runtime, never the key", async () => {
		const runtime = {
			worker: "tedi-runtime",
			fingerprints: await masterKeyFingerprints(RUNTIME_KEY),
		};
		const res = await call({
			SECRETS_MASTER_KEY: EDGE_KEY,
			TEDI_RUNTIME_SERVICE: runtimeService(runtime),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			workers: [
				{ worker: "tedi", fingerprints: await masterKeyFingerprints(EDGE_KEY) },
				runtime,
			],
		});
		const text = JSON.stringify(body);
		expect(text).not.toContain(EDGE_KEY);
		expect(text).not.toContain(RUNTIME_KEY);
	});

	it("degrades an unset edge key and a failing runtime to error entries", async () => {
		const res = await call({
			TEDI_RUNTIME_SERVICE: runtimeService({ error: "boom" }, 503),
		});
		expect(await res.json()).toEqual({
			workers: [
				{ worker: "tedi", fingerprints: [], error: "unset" },
				{ worker: "tedi-runtime", fingerprints: [], error: "http_503" },
			],
		});
	});

	it("reports an unbound runtime", async () => {
		const res = await call({ SECRETS_MASTER_KEY: EDGE_KEY });
		const body = (await res.json()) as { workers: { error?: string }[] };
		expect(body.workers[1]).toEqual({
			worker: "tedi-runtime",
			fingerprints: [],
			error: "unbound",
		});
	});

	it("is unreachable without a service binding", async () => {
		const res = await call({ SECRETS_MASTER_KEY: EDGE_KEY }, false);
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("fingerprints");
	});
});
