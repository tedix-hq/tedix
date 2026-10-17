import { describe, expect, it, vi } from "vite-plus/test";
import { createTediConsoleSession } from "./tedi-console";
describe("tedi session broker endpoint", () => {
	it("refuses ambient human cookies and non-POST methods", async () => {
		const api = { fetch: vi.fn() };
		expect(
			(
				await createTediConsoleSession(
					new Request("https://auth.example/tedix/session/tedi", {
						method: "POST",
						headers: { Cookie: "DS=human-session" },
					}),
					api,
				)
			).status,
		).toBe(401);
		expect(
			(
				await createTediConsoleSession(
					new Request("https://auth.example/tedix/session/tedi"),
					api,
				)
			).status,
		).toBe(405);
		expect(api.fetch).not.toHaveBeenCalled();
	});
	it("relays only the explicit tedi bearer, never cookies or injected authority", async () => {
		const api = {
			fetch: vi.fn(async (request: Request) => {
				expect(new URL(request.url).pathname).toBe(
					"/rpc/tediConsole/createSession",
				);
				expect(request.headers.get("Authorization")).toBe(
					"Bearer fictional-tedi-jwt",
				);
				expect(request.headers.get("Cookie")).toBeNull();
				expect(request.headers.get("X-Service-Binding")).toBeNull();
				expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBeNull();
				return Response.json({
					json: { sessionToken: "tcs_fictional-session", expiresAt: 123 },
				});
			}),
		};
		const response = await createTediConsoleSession(
			new Request("https://auth.example/tedix/session/tedi", {
				method: "POST",
				headers: {
					Authorization: "Bearer fictional-tedi-jwt",
					Cookie: "DS=human",
					"X-Service-Binding": "true",
					"X-Tedix-Tedi-Scopes": "*",
				},
			}),
			api,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			sessionToken: "tcs_fictional-session",
			expiresAt: 123,
		});
	});
	it("preserves grant denial without retrying credential issuance", async () => {
		const api = {
			fetch: vi.fn(async () =>
				Response.json(
					{
						json: { code: "FORBIDDEN", message: "Console access not granted" },
					},
					{ status: 403 },
				),
			),
		};
		const response = await createTediConsoleSession(
			new Request("https://auth.example/tedix/session/tedi", {
				method: "POST",
				headers: { Authorization: "Bearer fictional-tedi-jwt" },
			}),
			api,
		);
		expect(response.status).toBe(403);
		expect(api.fetch).toHaveBeenCalledTimes(1);
	});
});
