import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// The runtime exposes a module Worker's default object handler here, while the
// generated loopback type only enumerates RPC-compatible named exports.
const worker = (exports as typeof exports & { default: Fetcher }).default;

describe("tedi edge Worker boundary", () => {
	it("serves health through the real workerd entry", async () => {
		const response = await worker.fetch("https://tedi.tedix.dev/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "ok",
			service: "tedi",
			env: "development",
			deployedSha: "unknown",
			// The test mode binds no other Worker.
			runtimeDeployedSha: "unbound",
		});
	});

	it("strips a forged service-binding marker from public requests", async () => {
		const response = await worker.fetch(
			"https://tedi.tedix.dev/internal/workstation/reap",
			{ method: "POST", headers: { "X-Service-Binding": "tedix-api" } },
		);

		expect(response.status).toBe(401);
	});

	it("binds local storage and no remote-only binding", () => {
		const bindings = env as unknown as Record<string, unknown>;
		expect(bindings.DB).toBeDefined();
		expect(bindings.TEDI_STORAGE).toBeDefined();
		expect(bindings.BACKUP_BUCKET).toBeDefined();
		expect(bindings.ARTIFACTS).toBeUndefined();
	});
});
