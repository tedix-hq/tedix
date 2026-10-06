import { describe, expect, it, vi } from "vite-plus/test";

// Same pattern as the workflow tests: `cloudflare:*` has no Node resolution.
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
	WorkerEntrypoint: class {
		constructor(
			readonly ctx: ExecutionContext,
			readonly env: CloudflareEnv,
		) {}
	},
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class NonRetryableError extends Error {},
}));

/**
 * Counts evaluations of `./worker-app`. The factory runs on first import, and
 * `src/index.ts` imports it only inside `loadApp()` — so this counter is a
 * direct measurement of whether a request paid for the app module graph.
 *
 * That is the property under test. `/health` in worker-app.ts is a static JSON
 * literal, but reaching it evaluates the whole graph, which on a cold isolate
 * costs seconds of CPU. Asserting "status 200" alone would not catch a regression here —
 * the short-circuit could vanish and the response would look identical, just
 * slow. Asserting the counter is what makes this a real guard.
 */
const h = vi.hoisted(() => ({ evaluations: 0 }));

vi.mock("./worker-app", () => {
	h.evaluations++;
	return {
		default: {
			fetch: (request: Request) =>
				new Response("from worker-app", {
					status: 418,
					headers: {
						"X-Seen-Service-Binding":
							request.headers.get("X-Service-Binding") ?? "absent",
					},
				}),
		},
	};
});

// The Durable Object exports pull the real kernel graph, which cannot evaluate
// under vitest. These tests only exercise the default fetch export.
vi.mock("./kernel/kernel-do", () => ({ KernelDOv4: class {} }));
vi.mock("./kernel/kernel-voice-do", () => ({ KernelVoiceDO: class {} }));
vi.mock("./kernel/kernel-voice-input-do", () => ({
	KernelVoiceInputDO: class {},
}));

import worker, { InternalEntrypoint } from "./index";

const env = {} as CloudflareEnv;
const ctx = {} as ExecutionContext;
const call = (url: string, init?: RequestInit) =>
	worker.fetch(new Request(url, init), env, ctx);

describe("apps/api entrypoint liveness short-circuit", () => {
	it("answers GET /health without evaluating worker-app", async () => {
		const before = h.evaluations;
		const res = await call("https://api.tedix.dev/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ status: "ok", service: "api" });
		expect(typeof body.timestamp).toBe("string");
		// The release signal: the only unauthenticated answer to "is my commit
		// live". An empty env must degrade to "unknown" rather than omit the
		// field — a missing key reads as an old deploy that predates it, which
		// is exactly the wrong conclusion.
		expect(body.deployedSha).toBe("unknown");
		// Delta, not absolute: the module registry caches the factory and
		// loadApp() memoises, so a later test hitting the app increments this
		// exactly once. What matters is that THIS call added nothing.
		expect(h.evaluations).toBe(before);
	});

	it("reports the deploy-time release SHA on /health", async () => {
		const res = await worker.fetch(
			new Request("https://api.tedix.dev/health"),
			{
				GIT_SHA: "3cea01c4b3e07a325f08c9ccd6ca06fc5cb1b95a",
			} as unknown as CloudflareEnv,
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.deployedSha).toBe("3cea01c4b3e07a325f08c9ccd6ca06fc5cb1b95a");
	});

	it("does NOT short-circuit /health/skill-runtime", async () => {
		// The deploy lane compares this route against the runtime's own health
		// endpoint to catch a stale service binding, so it must reach the app.
		const res = await call("https://api.tedix.dev/health/skill-runtime");
		expect(res.status).toBe(418);
	});

	it("does not short-circuit a non-GET /health", async () => {
		const res = await call("https://api.tedix.dev/health", { method: "POST" });
		expect(res.status).toBe(418);
	});

	it("does not short-circuit ordinary routes", async () => {
		const res = await call("https://api.tedix.dev/rpc/apps/list");
		expect(res.status).toBe(418);
	});

	it("ignores query strings and matches the path exactly", async () => {
		const before = h.evaluations;
		const res = await call("https://api.tedix.dev/health?verbose=1");
		expect(res.status).toBe(200);
		expect(h.evaluations).toBe(before);
	});
});

describe("apps/api service-binding trust boundary", () => {
	const spoofed = () =>
		new Request("https://api.tedix.dev/rpc/apps/list", {
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": "org-forged",
				"X-Tedix-Tedi-Scopes": "platform:admin",
			},
		});

	it("strips a spoofed service-binding marker on public ingress", async () => {
		const res = await worker.fetch(spoofed(), env, ctx);
		expect(res.headers.get("X-Seen-Service-Binding")).toBe("absent");
	});

	it("keeps the marker on the service-binding-only entrypoint", async () => {
		const internal = new InternalEntrypoint(ctx, env);
		const res = await internal.fetch(spoofed());
		expect(res.headers.get("X-Seen-Service-Binding")).toBe("true");
	});
});
