import { describe, expect, it } from "vite-plus/test";
import { health } from "./health";

/**
 * /health carries the release SHA because it is the only unauthenticated answer
 * to "is my commit live". Deploy job conclusions are not one: a superseded
 * deploy exits 0 having shipped nothing, so green means "ran", not "shipped".
 */
describe("tedi /health release signal", () => {
	const call = (env: Record<string, unknown>) =>
		health.request("/health", {}, env);

	/** A service binding that answers like apps/tedi-runtime's own /health. */
	const runtimeService = (body: unknown, ok = true) => ({
		fetch: async () =>
			new Response(JSON.stringify(body), {
				status: ok ? 200 : 503,
				headers: { "Content-Type": "application/json" },
			}),
	});

	it("reports the deploy-time release SHA", async () => {
		const res = await call({
			ENVIRONMENT: "production",
			GIT_SHA: "5ccd0312dcbeea53a5e2b1e22a31ae797a6f6e28",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			status: "ok",
			service: "tedi",
			deployedSha: "5ccd0312dcbeea53a5e2b1e22a31ae797a6f6e28",
		});
	});

	// A missing key would read as a deploy that predates this field, which is
	// exactly the wrong conclusion — so it degrades to a value, never to absence.
	it("degrades to 'unknown' rather than omitting the field", async () => {
		const body = (await (
			await call({ ENVIRONMENT: "development" })
		).json()) as Record<string, unknown>;
		expect(body.deployedSha).toBe("unknown");
		expect("deployedSha" in body).toBe(true);
	});
});

/**
 * The runtime declares no routes, so its own /health is unreachable from
 * outside. The edge answers on its behalf over the service binding — and must
 * keep answering when the runtime does not, since the two deploy separately.
 */
describe("tedi /health runtime release signal", () => {
	const call = (env: Record<string, unknown>) =>
		health.request("/health", {}, env);

	const runtimeService = (body: unknown, status = 200) => ({
		fetch: async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	});

	it("surfaces the runtime's own deployed SHA", async () => {
		const body = (await (
			await call({
				ENVIRONMENT: "production",
				GIT_SHA: "edge-sha",
				TEDI_RUNTIME_SERVICE: runtimeService({
					status: "ok",
					service: "tedi-runtime",
					deployedSha: "runtime-sha",
				}),
			})
		).json()) as Record<string, unknown>;
		// The two deploy independently, so they are reported independently.
		expect(body.deployedSha).toBe("edge-sha");
		expect(body.runtimeDeployedSha).toBe("runtime-sha");
	});

	it("stays ok when the runtime is unreachable", async () => {
		const res = await call({
			ENVIRONMENT: "production",
			GIT_SHA: "edge-sha",
			TEDI_RUNTIME_SERVICE: {
				fetch: async () => {
					throw new Error("runtime down");
				},
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body.runtimeDeployedSha).toBe("unreachable");
	});

	it("reports a non-200 runtime as unreachable, not as a SHA", async () => {
		const body = (await (
			await call({
				ENVIRONMENT: "production",
				TEDI_RUNTIME_SERVICE: runtimeService({ deployedSha: "x" }, 503),
			})
		).json()) as Record<string, unknown>;
		expect(body.runtimeDeployedSha).toBe("unreachable");
	});

	it("reports an unbound binding distinctly from an unreachable one", async () => {
		const body = (await (
			await call({ ENVIRONMENT: "development" })
		).json()) as Record<string, unknown>;
		// "unbound" and "unreachable" are different operator problems.
		expect(body.runtimeDeployedSha).toBe("unbound");
	});

	it("degrades to a value when the runtime predates the field", async () => {
		const body = (await (
			await call({
				ENVIRONMENT: "production",
				TEDI_RUNTIME_SERVICE: runtimeService({ status: "ok" }),
			})
		).json()) as Record<string, unknown>;
		expect(body.runtimeDeployedSha).toBe("unknown");
	});
});
