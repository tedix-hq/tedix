import { describe, expect, test } from "bun:test";
import { resolvePublicCliWorkspace } from "./workspace-resolver";

describe("public CLI workspace resolver", () => {
	test("resolves an organization without an existing login", async () => {
		let requested = "";
		const workspace = await resolvePublicCliWorkspace({
			slug: " Acme ",
			apiUrl: "https://api.example.test/",
			fetch: async (input) => {
				requested = String(input);
				return Response.json({
					slug: "acme",
					name: "Acme",
					gatewayUrl: "https://acme-unified.mcp.tedix.dev/mcp",
				});
			},
		});

		expect(requested).toBe(
			"https://api.example.test/v1/organizations/cli-workspace/acme",
		);
		expect(workspace.gatewayUrl).toBe("https://acme-unified.mcp.tedix.dev/mcp");
	});

	test("gives a useful error for an unknown organization", async () => {
		await expect(
			resolvePublicCliWorkspace({
				slug: "missing",
				fetch: async () => new Response("not found", { status: 404 }),
			}),
		).rejects.toThrow(
			'No provisioned Tedix organization was found for slug "missing"',
		);
	});

	const ok = () =>
		Response.json({
			slug: "acme",
			name: "Acme",
			gatewayUrl: "https://acme-unified.mcp.tedix.dev/mcp",
		});
	const noSleep = () => Promise.resolve();

	test("retries a transient 5xx and then succeeds (cold isolate)", async () => {
		let calls = 0;
		const workspace = await resolvePublicCliWorkspace({
			slug: "acme",
			sleep: noSleep,
			fetch: async () => {
				calls++;
				return calls < 3 ? new Response("cold", { status: 500 }) : ok();
			},
		});
		expect(calls).toBe(3);
		expect(workspace.slug).toBe("acme");
	});

	test("retries a thrown network error then succeeds", async () => {
		let calls = 0;
		const workspace = await resolvePublicCliWorkspace({
			slug: "acme",
			sleep: noSleep,
			fetch: async () => {
				calls++;
				if (calls === 1) throw new Error("ECONNRESET");
				return ok();
			},
		});
		expect(calls).toBe(2);
		expect(workspace.slug).toBe("acme");
	});

	test("does NOT retry a 404 — fails fast on a real missing org", async () => {
		let calls = 0;
		await expect(
			resolvePublicCliWorkspace({
				slug: "missing",
				sleep: noSleep,
				fetch: async () => {
					calls++;
					return new Response("not found", { status: 404 });
				},
			}),
		).rejects.toThrow("No provisioned Tedix organization");
		expect(calls).toBe(1);
	});

	test("surfaces the HTTP error after exhausting retries on a persistent 5xx", async () => {
		let calls = 0;
		await expect(
			resolvePublicCliWorkspace({
				slug: "acme",
				sleep: noSleep,
				fetch: async () => {
					calls++;
					return new Response("down", { status: 503 });
				},
			}),
		).rejects.toThrow("(HTTP 503)");
		expect(calls).toBe(3);
	});

	test("rejects unsafe or malformed gateway records", async () => {
		for (const gatewayUrl of [
			"http://evil.example/mcp",
			"https://acme.example/not-mcp",
		]) {
			await expect(
				resolvePublicCliWorkspace({
					slug: "acme",
					apiUrl: "https://api.example.test/",
					fetch: async () =>
						Response.json({ slug: "acme", name: "Acme", gatewayUrl }),
				}),
			).rejects.toThrow("invalid workspace record");
		}
	});
});
