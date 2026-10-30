import { describe, expect, it, vi } from "vite-plus/test";
import {
	createHumanMcpAdmissionRevalidator,
	type MultiOrgMcpSelection,
} from "./auth-helpers";

const config = {
	audience: "https://connect.mcp.example.test/mcp",
	mcpServerId: "test-server",
	multiOrganization: true,
};
const selection: MultiOrgMcpSelection = {
	effectiveScopes: ["mcp:apps.read", "mcp:work.read"],
	organizations: [
		{
			organizationId: "org-one",
			descopeTenantId: "tenant-one",
			gatewaySlug: "one",
		},
		{
			organizationId: "org-two",
			descopeTenantId: "tenant-two",
			gatewaySlug: "two",
		},
	],
};
function fixture() {
	const payload = {
		iss: "test-issuer",
		aud: config.audience,
		exp: Math.floor(Date.now() / 1000) + 60,
		azp: "test-client",
		sub: "test-user",
		dci: "test-consent",
		tedixConsentRevision: "test-revision",
		token_type: "access_token",
		scope: "mcp:apps.read mcp:work.read",
		tedixSelectedOrganizations: ["tenant-one", "tenant-two"],
	};
	const fetch = vi
		.fn()
		.mockResolvedValue(
			Response.json({ json: { allowed: true, ...structuredClone(selection) } }),
		);
	const env = { API_SERVICE: { fetch } } as unknown as CloudflareEnv;
	return { payload, fetch, env };
}

describe("queued human MCP authority", () => {
	it("rechecks live authority and permits only the original routing and scopes", async () => {
		const { payload, fetch, env } = fixture();
		fetch.mockResolvedValueOnce(
			Response.json({
				json: {
					allowed: true,
					...selection,
					effectiveScopes: [...selection.effectiveScopes!].reverse(),
				},
			}),
		);
		const check = createHumanMcpAdmissionRevalidator(
			payload,
			env,
			config,
			selection,
		);
		payload.tedixSelectedOrganizations.reverse();
		expect(await check()).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["organizationId", "gatewaySlug"] as const)(
		"rejects a changed %s",
		async (key) => {
			const { payload, fetch, env } = fixture();
			const changed = structuredClone(selection);
			changed.organizations[0]![key] = "changed";
			fetch.mockResolvedValueOnce(
				Response.json({ json: { allowed: true, ...changed } }),
			);
			const response = await createHumanMcpAdmissionRevalidator(
				payload,
				env,
				config,
				selection,
			)();
			expect(response?.status).toBe(403);
			expect(await response?.json()).toMatchObject({
				reason: "selection_changed_while_queued",
			});
		},
	);

	it.each(["mcp:apps.read", "mcp:apps.read mcp:work.read platform:admin"])(
		"rejects changed scope authority: %s",
		async (scopes) => {
			const { payload, fetch, env } = fixture();
			payload.scope += " platform:admin";
			fetch.mockResolvedValueOnce(
				Response.json({
					json: {
						allowed: true,
						...selection,
						effectiveScopes: scopes.split(" "),
					},
				}),
			);
			const response = await createHumanMcpAdmissionRevalidator(
				payload,
				env,
				config,
				selection,
			)();
			expect(response?.status).toBe(403);
		},
	);

	it.each(["reordered", "tenant-changed"])(
		"rejects %s organization bindings",
		async (kind) => {
			const { payload, fetch, env } = fixture();
			const changed = structuredClone(selection);
			if (kind === "reordered") changed.organizations.reverse();
			else changed.organizations[0]!.descopeTenantId = "different-tenant";
			fetch.mockResolvedValueOnce(
				Response.json({ json: { allowed: true, ...changed } }),
			);
			const response = await createHumanMcpAdmissionRevalidator(
				payload,
				env,
				config,
				selection,
			)();
			expect(response?.status).toBe(403);
		},
	);

	it("rejects a revoked grant and distinguishes unavailable verification", async () => {
		const { payload, fetch, env } = fixture();
		const check = createHumanMcpAdmissionRevalidator(
			payload,
			env,
			config,
			selection,
		);
		fetch.mockResolvedValueOnce(
			Response.json({
				json: {
					allowed: false,
					reason: "consent_revoked",
					organizations: [],
				},
			}),
		);
		expect((await check())?.status).toBe(403);
		fetch.mockRejectedValueOnce(new Error("unavailable"));
		const unavailable = await check();
		expect(unavailable?.status).toBe(503);
		expect(unavailable?.headers.get("Retry-After")).toBe("5");
	});

	it.each(["before", "during"])(
		"returns refreshable 401 when JWT expires %s revalidation",
		async (when) => {
			const { payload, fetch, env } = fixture();
			if (when === "before") payload.exp = Math.floor(Date.now() / 1000) - 1;
			const check = createHumanMcpAdmissionRevalidator(
				payload,
				env,
				config,
				selection,
			);
			if (when === "during")
				fetch.mockImplementationOnce(async () => {
					vi.spyOn(Date, "now").mockReturnValue((payload.exp + 1) * 1000);
					return Response.json({ json: { allowed: true, ...selection } });
				});
			try {
				const response = await check();
				expect(response?.status).toBe(401);
				expect(response?.headers.get("WWW-Authenticate")).toContain(
					'error="invalid_token"',
				);
				expect(fetch).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
			} finally {
				vi.restoreAllMocks();
			}
		},
	);
});
