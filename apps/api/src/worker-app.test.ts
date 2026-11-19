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
		expect(response.headers.get("X-Tedix-Trace-Id")).toMatch(/^[a-f0-9-]{36}$/);
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
		expect(response.headers.get("X-Tedix-Trace-Id")).toMatch(/^[a-f0-9-]{36}$/);
		expect(await response.json()).toEqual({ error: "Internal server error" });
		expect(logs.records()).toContainEqual({
			event: "api.openapi_spec_generation_failed",
			exception: { type: "Error", cause: { type: "SyntaxError" } },
		});
		expect(JSON.stringify(logs.spy.mock.calls)).not.toContain(secret);
	});
});

const env = {
	API_URL: "https://api.tedi.club/",
} as CloudflareEnv;
const ctx = {} as ExecutionContext;

describe("public API discovery routes", () => {
	it("returns canonical catalog URLs and Link discovery from the API root", async () => {
		const response = await worker.fetch(
			new Request("https://untrusted.example/"),
			env,
			ctx,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Link")).toContain(
			'<https://api.tedi.club/openapi.json>; rel="service-desc"',
		);
		expect(await response.json()).toEqual({
			name: "Tedix API",
			openapi: "https://api.tedi.club/openapi.json",
			documentation: "https://api.tedi.club/docs",
		});
	});

	it("publishes an absolute HTML service-description link", async () => {
		const response = await worker.fetch(
			new Request("https://api.tedi.club/docs"),
			env,
			ctx,
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Link")).toContain(
			'<https://api.tedi.club/docs>; rel="service-doc"',
		);
		expect(html).toContain(
			'rel="service-desc" type="application/vnd.oai.openapi+json;version=3.1" href="https://api.tedi.club/openapi.json"',
		);
	});
});
