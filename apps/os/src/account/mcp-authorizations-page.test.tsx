import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("@/lib/api", () => ({ osApi: { organizations: {} } }));
import {
	authorizationStatus,
	McpAuthorizationCard,
} from "./mcp-authorizations-page";
const item = {
	mcpServerId: "connect",
	clientId: "client",
	clientName: "ChatGPT",
	revision: "00000000-0000-4000-8000-000000000001",
	status: "active" as const,
	providerStatus: "missing" as const,
	selectedTenantIds: ["org_tedix"],
	approvedScopes: ["mcp:work.read"],
	updatedAt: "2026-10-03",
};
describe("MCP authorization presentation", () => {
	it("distinguishes staged selections from verified provider consent", () => {
		expect(authorizationStatus(item)).toBe("Reconnect needed");
		expect(
			authorizationStatus({ ...item, providerStatus: "unavailable" }),
		).toBe("Connection not verified");
		expect(authorizationStatus({ ...item, providerStatus: "present" })).toBe(
			"Permission recorded",
		);
		expect(authorizationStatus({ ...item, status: "revoked" })).toBe(
			"Access disabled",
		);
	});
	it("shows known organization names without inventing removed memberships", () => {
		const html = renderToStaticMarkup(
			<McpAuthorizationCard
				item={item}
				onDisable={() => {}}
				pending={false}
				organizationNames={{ org_tedix: "Tedix" }}
			/>,
		);
		expect(html).toContain("Organizations: Tedix");
	});
	it("offers access disabling only for active selections", () => {
		expect(
			renderToStaticMarkup(
				<McpAuthorizationCard
					item={item}
					onDisable={() => {}}
					pending={false}
				/>,
			),
		).toContain("Disable Tedix access");
		expect(
			renderToStaticMarkup(
				<McpAuthorizationCard
					item={{ ...item, status: "revoked" }}
					onDisable={() => {}}
					pending={false}
				/>,
			),
		).not.toContain("Disable Tedix access");
	});
});
