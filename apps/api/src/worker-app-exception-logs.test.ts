import { OpenAPIGenerator } from "@orpc/openapi";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import worker from "./worker-app";

const baseEnv = {
	API_URL: "https://api.tedix.dev",
	OS_URL: "https://os.tedix.dev",
	API_RATE_LIMITER: { limit: async () => ({ success: true }) },
	DB: { withSession: () => ({ getBookmark: () => null }) },
};

const context = {
	waitUntil: () => {},
	passThroughOnException: () => {},
	props: {},
} as unknown as ExecutionContext;

function captureErrorLogs() {
	const spy = vi.spyOn(console, "error").mockImplementation(() => {});
	return {
		spy,
		records: () => spy.mock.calls.map(([line]) => JSON.parse(String(line))),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("public API route failures", () => {
	it("keeps the binding failure response and omits caught provider text", async () => {
		const secret = "Bearer provider-secret";
		const logs = captureErrorLogs();
		const env = {
			...baseEnv,
			SKILL_RUNTIME: {
				fetch: async () => {
					throw new Error(`binding failed: ${secret}`, {
						cause: new TypeError(`provider said ${secret}`),
					});
				},
			},
		} as unknown as CloudflareEnv;

		const response = await worker.fetch(
			new Request("https://api.tedix.dev/health/skill-runtime"),
			env,
			context,
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			status: "error",
			service: "api-skill-runtime-binding",
			error: "skill_runtime_binding_unavailable",
		});
		expect(logs.records()).toContainEqual({
			event: "api.skill_runtime_binding_health_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(logs.spy.mock.calls)).not.toContain(secret);
	});

	it("keeps the OpenAPI failure response and omits generator text", async () => {
		const secret = "sk_live_generator-secret";
		vi.spyOn(OpenAPIGenerator.prototype, "generate").mockRejectedValueOnce(
			new Error(`schema failed: ${secret}`, {
				cause: new SyntaxError(`invalid ${secret}`),
			}),
		);
		const logs = captureErrorLogs();

		const response = await worker.fetch(
			new Request("https://api.tedix.dev/openapi.json"),
			baseEnv as unknown as CloudflareEnv,
			context,
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal server error" });
		expect(logs.records()).toContainEqual({
			event: "api.openapi_spec_generation_failed",
			exception: { type: "Error", cause: { type: "SyntaxError" } },
		});
		expect(JSON.stringify(logs.spy.mock.calls)).not.toContain(secret);
	});
});
