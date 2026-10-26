import { describe, expect, it, vi } from "vite-plus/test";
import { workspaceAppRuntime } from "./workspace-app-runtime";

describe("workspace app runtime relay", () => {
	it("forwards a trusted invocation before tedi slug resolution", async () => {
		const fetch = vi.fn(async (request: Request) => {
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			expect(await request.json()).toEqual({
				session: "fictional-signed-session",
			});
			return Response.json({ count: 1 });
		});
		const response = await workspaceAppRuntime.request(
			"/__internal/workspace-app/call",
			{
				method: "POST",
				headers: {
					"X-Service-Binding": "true",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ session: "fictional-signed-session" }),
			},
			{ TEDI_RUNTIME_SERVICE: { fetch } },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ count: 1 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("denies untrusted traffic and fails closed without a runtime binding", async () => {
		const request = (headers: Record<string, string>) =>
			workspaceAppRuntime.request(
				"/__internal/workspace-app/call",
				{ method: "POST", headers },
				{},
			);
		expect((await request({})).status).toBe(403);
		expect((await request({ "X-Service-Binding": "TRUE" })).status).toBe(403);
		expect((await request({ "X-Service-Binding": "true" })).status).toBe(503);
	});
	it("forwards trusted save validation", async () => {
		const fetch = vi.fn(async () => Response.json({ valid: true }));
		const request = (headers: Record<string, string>) =>
			workspaceAppRuntime.request(
				"/__internal/workspace-app/validate",
				{ method: "POST", headers, body: "{}" },
				{ TEDI_RUNTIME_SERVICE: { fetch } },
			);
		expect((await request({})).status).toBe(403);
		expect((await request({ "X-Service-Binding": "true" })).status).toBe(200);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("forwards trusted revocations and denies untrusted ones", async () => {
		const fetch = vi.fn(async () => Response.json({ restarted: 1 }));
		const request = (headers: Record<string, string>) =>
			workspaceAppRuntime.request(
				"/__internal/workspace-app/revoke",
				{ method: "POST", headers, body: "{}" },
				{ TEDI_RUNTIME_SERVICE: { fetch } },
			);
		expect((await request({})).status).toBe(403);
		expect((await request({ "X-Service-Binding": "true" })).status).toBe(200);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

it("relays draft closure only over the trusted service binding", async () => {
	const fetch = vi.fn(async () => Response.json({ closed: true }));
	for (const [headers, status] of [
		[{}, 403],
		[{ "X-Service-Binding": "true" }, 200],
	] as const) {
		const response = await workspaceAppRuntime.request(
			"/__internal/workspace-app/close-draft",
			{ method: "POST", headers, body: "{}" },
			{ TEDI_RUNTIME_SERVICE: { fetch } },
		);
		expect(response.status).toBe(status);
	}
	expect(fetch).toHaveBeenCalledOnce();
});
