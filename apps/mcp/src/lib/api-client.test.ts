import { gatewayReadBinding } from "./gateway-read-cache";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	getApiClient,
	getTediProfileApiClient,
	MCP_EDGE_CONTROL_PLANE_SCOPES,
} from "./api-client";

describe("MCP edge API service role", () => {
	it("rejects a missing service binding", () => {
		expect(() => getApiClient()).toThrow(
			"Service binding (serviceFetch) is required",
		);
	});
	it("delegates only the reviewed control-plane read scopes", async () => {
		expect(MCP_EDGE_CONTROL_PLANE_SCOPES).toEqual(["apps:read", "tedis:read"]);
		expect(MCP_EDGE_CONTROL_PLANE_SCOPES).not.toContain("*");
		expect(MCP_EDGE_CONTROL_PLANE_SCOPES).not.toContain("platform:admin");

		const fetch = vi.fn(async (request: Request) => {
			expect(new URL(request.url).origin).toBe("https://api");
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe(
				"apps:read tedis:read",
			);
			return Response.json({ json: { id: "app-1" } });
		});
		const client = getApiClient({
			serviceFetch: { fetch } as unknown as Fetcher,
		});
		await client.apps.get({
			appId: "00000000-0000-4000-8000-000000000001",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("scopes cross-org tedi profile reads to the internal system tenant", async () => {
		const fetch = vi.fn(async (request: Request) => {
			expect(new URL(request.url).origin).toBe("https://api");
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			expect(request.headers.get("X-Tedix-Org-Id")).toBe("system");
			expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe(
				"apps:read tedis:read",
			);
			return Response.json({ json: { id: "tedi-1" } });
		});
		const client = getTediProfileApiClient({ fetch } as unknown as Fetcher);
		await client.tedis.get({
			tediId: "00000000-0000-4000-8000-000000000001",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("gateway authority read cache", () => {
	afterEach(() => vi.restoreAllMocks());
	const policyPath = "mcpGovernance/resolveAgentTransportPolicy";
	const request = (path = policyPath, session = "session", input = {}) =>
		new Request(`https://api/rpc/${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Tedix-External-Agent-Session-Id": session,
			},
			body: JSON.stringify({ json: input }),
		});

	it("coalesces twenty sessions independently and refreshes authority at ten seconds", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let allowed = true;
		const fetch = vi.fn(async () => Response.json({ json: { allowed } }));
		const cached = gatewayReadBinding({ fetch });
		const burst = () =>
			Promise.all(
				Array.from({ length: 100 }, async (_, index) =>
					(
						await cached.fetch(request(policyPath, `session-${index % 20}`))
					).json(),
				),
			);
		expect(await burst()).toHaveLength(100);
		expect(fetch).toHaveBeenCalledTimes(20);
		allowed = false;
		now += 9_999;
		for (const value of await burst())
			expect(value).toEqual({ json: { allowed: true } });
		expect(fetch).toHaveBeenCalledTimes(20);
		now += 1;
		for (const value of await burst())
			expect(value).toEqual({ json: { allowed: false } });
		expect(fetch).toHaveBeenCalledTimes(40);
	});

	it("reuses policy reads across newly constructed typed API clients", async () => {
		const fetch = vi.fn(async () =>
			Response.json({ json: { requireExplicitApprovalPolicy: true } }),
		);
		const serviceFetch = { fetch } as unknown as Fetcher;
		const read = () =>
			getApiClient({
				serviceFetch,
				orgId: "org",
			}).mcpGovernance.resolveAgentTransportPolicy({
				organizationId: "00000000-0000-4000-8000-000000000001",
			});
		expect(await read()).toEqual({ requireExplicitApprovalPolicy: true });
		expect(await read()).toEqual({ requireExplicitApprovalPolicy: true });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("reuses an organization's policy presence read for ten seconds", async () => {
		const fetch = vi.fn(async () => Response.json({ json: { fenced: false } }));
		const cached = gatewayReadBinding({ fetch });
		const path = "mcpGovernance/resolveTenantPolicyOrganizationPresence";
		await cached.fetch(request(path, "a", { organizationId: "org" }));
		await cached.fetch(request(path, "a", { organizationId: "org" }));
		await cached.fetch(request(path, "a", { organizationId: "other" }));
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("separates inputs, authority headers and service bindings, and bypasses writes", async () => {
		const fetch = vi.fn(async () => Response.json({ json: {} }));
		const first = gatewayReadBinding({ fetch });
		await first.fetch(request());
		await first.fetch(request(policyPath, "other"));
		await first.fetch(
			request(policyPath, "session", { organizationId: "other" }),
		);
		await gatewayReadBinding({ fetch }).fetch(request());
		await first.fetch(request("audit/createEvent"));
		await first.fetch(request("audit/createEvent"));
		expect(fetch).toHaveBeenCalledTimes(6);
	});

	it("holds an unavailable grant for five seconds and never retains denials or rejected fetches", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ error: "unavailable" }, { status: 503 }),
			)
			.mockRejectedValueOnce(new Error("binding unavailable"))
			.mockResolvedValueOnce(
				Response.json({
					json: { allowed: false, reason: "provider_unavailable" },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ json: { allowed: false, reason: "consent_revoked" } }),
			)
			.mockResolvedValue(Response.json({ json: { allowed: true } }));
		const cached = gatewayReadBinding({ fetch });
		const path = "organizations/verifyMultiOrgMcpGrant";
		expect((await cached.fetch(request(path))).status).toBe(503);
		// A busy D1 answers once per key per five seconds, not once per caller.
		expect((await cached.fetch(request(path))).status).toBe(503);
		expect(fetch).toHaveBeenCalledTimes(1);
		now += 5_000;
		await expect(cached.fetch(request(path))).rejects.toThrow(
			"binding unavailable",
		);
		expect(await (await cached.fetch(request(path))).json()).toMatchObject({
			json: { allowed: false, reason: "provider_unavailable" },
		});
		await cached.fetch(request(path));
		expect(fetch).toHaveBeenCalledTimes(3);
		now += 5_000;
		expect(await (await cached.fetch(request(path))).json()).toMatchObject({
			json: { reason: "consent_revoked" },
		});
		await cached.fetch(request(path));
		await cached.fetch(request(path));
		expect(fetch).toHaveBeenCalledTimes(5);
	});

	it("keeps an allowed grant for two minutes", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetch = vi.fn(async () => Response.json({ json: { allowed: true } }));
		const cached = gatewayReadBinding({ fetch });
		const path = "organizations/verifyMultiOrgMcpGrant";
		await cached.fetch(request(path));
		now += 119_999;
		await cached.fetch(request(path));
		expect(fetch).toHaveBeenCalledOnce();
		now += 1;
		await cached.fetch(request(path));
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("evicts old authority keys during a burst of fresh callers", async () => {
		const fetch = vi.fn(async () => Response.json({ json: {} }));
		const cached = gatewayReadBinding({ fetch });
		for (let index = 0; index <= 500; index++)
			await cached.fetch(request(policyPath, `${index}`));
		await cached.fetch(request(policyPath, "500"));
		expect(fetch).toHaveBeenCalledTimes(501);
		await cached.fetch(request(policyPath, "0"));
		expect(fetch).toHaveBeenCalledTimes(502);
	});
});
