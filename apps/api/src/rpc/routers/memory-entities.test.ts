import { describe, expect, it } from "vite-plus/test";
import {
	hasMemoryEntityGovernanceAuthority,
	resolveMemoryEntityActor,
} from "./memory-entities";

describe("memory entity governance access", () => {
	it("uses verified external-agent identity before every ambient credential", () => {
		expect(
			resolveMemoryEntityActor({
				authType: "service-binding",
				externalAgentPrincipalId: "external-agent-1",
				tediId: "tedi-1",
				user: { sub: "owner-1" } as never,
				apiKey: {
					id: "key-1",
					organizationId: "org-1",
					name: "operator",
				},
				organizationId: "org-1",
				serviceAccount: { clientId: "gateway" },
			}),
		).toEqual({ type: "external_agent", id: "external-agent-1" });
		expect(
			hasMemoryEntityGovernanceAuthority({
				authType: "service-binding",
				externalAgentPrincipalId: "external-agent-1",
				tediId: "cto",
				tediScopes: ["platform:admin"],
			}),
		).toBe(false);
	});

	it("collapses API-key identities to the organization authority root", () => {
		expect(
			resolveMemoryEntityActor({
				authType: "apikey",
				organizationId: "org-1",
				apiKey: {
					id: "key-17",
					organizationId: "org-1",
					name: "governor",
					scopes: ["platform:admin"],
				},
			}),
		).toEqual({ type: "api_key", id: "organization:org-1" });
	});

	it("allows only explicit owner/admin or admin-scoped tedi authority", () => {
		expect(
			hasMemoryEntityGovernanceAuthority({
				authType: "user",
				userRole: "owner",
				user: { sub: "owner-1" } as never,
			}),
		).toBe(true);
		expect(
			hasMemoryEntityGovernanceAuthority({
				authType: "user",
				userRole: "member",
				user: { sub: "member-1" } as never,
			}),
		).toBe(false);
		expect(
			hasMemoryEntityGovernanceAuthority({
				authType: "tedi",
				tediId: "cto",
				tediScopes: ["mcp:memory.admin"],
			}),
		).toBe(true);
		expect(
			hasMemoryEntityGovernanceAuthority({
				authType: "tedi",
				tediId: "researcher",
				tediScopes: ["mcp:memory.write"],
			}),
		).toBe(false);
		expect(
			hasMemoryEntityGovernanceAuthority({
				authType: "apikey",
				apiKey: {
					id: "key-1",
					organizationId: "org-1",
					name: "governor",
					scopes: ["platform:admin"],
				},
			}),
		).toBe(true);
	});
});
