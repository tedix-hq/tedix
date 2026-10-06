import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import docsRuntime from "./index";

// The runtime exposes a module Worker's default object handler here, while the
// generated loopback type only enumerates RPC-compatible named exports.
const worker = (exports as typeof exports & { default: Fetcher }).default;

describe("docs runtime Worker boundary", () => {
	it("serves health through the real workerd entry", async () => {
		const response = await worker.fetch("https://docs.tedix.dev/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			// Builds stamp GIT_SHA, else GITHUB_SHA (set on Actions), else "unknown".
			deployedSha: expect.stringMatching(/^(?:unknown|[0-9a-f]{40})$/),
			service: "docs-runtime",
			status: "ok",
		});
	});

	it("rejects unsupported methods before storage access", async () => {
		const response = await worker.fetch("https://docs.tedix.dev/", {
			method: "POST",
		});

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, HEAD");
	});

	it("keeps request and configuration content out of failure logs", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await docsRuntime.fetch(
				new Request("https://docs.tedix.dev/private?key=request-secret"),
				{
					DB: undefined as unknown as D1Database,
					DOCS_BUILDS: undefined as unknown as R2Bucket,
					ENVIRONMENT: "test",
					GIT_SHA: "test",
					DOCS_BASE_DOMAIN: "docs.tedix.dev",
					DOCS_ROOT_SITE_SLUG: "tedix",
					DOCS_HOST_ALIASES: "{config-secret",
					DESCOPE_PROJECT_ID: "test",
					DESCOPE_BASE_URL: "https://auth.tedix.dev",
				},
			);
			expect(response.status).toBe(500);
			expect(log).toHaveBeenCalledWith({
				component: "docs-runtime",
				message: "Docs runtime request failed",
				event: "docs.request.failed",
				failure: { name: "SyntaxError" },
			});
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|key=|stack/i);
		} finally {
			log.mockRestore();
		}
	});
});
