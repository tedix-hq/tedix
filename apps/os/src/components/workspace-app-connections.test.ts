import { describe, expect, it, vi } from "vite-plus/test";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import { appConnectionRows } from "./workspace-app-connections";

vi.mock("@/lib/api", () => ({ osApi: {}, osChatMutationApi: {} }));

function resource(
	overrides: Partial<OsWorkspaceResource> = {},
): OsWorkspaceResource {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		organizationId: "org",
		workspaceId: "22222222-2222-4222-8222-222222222222",
		slot: "order_sheet",
		providerId: "google-sheets",
		connectionScope: "tenant",
		personalOwnerUserId: null,
		connectionInstanceId: null,
		providerAccess: null,
		requiredScopes: [],
		resourceType: "spreadsheet",
		providerResourceId: "sheet-1",
		name: "Orders 2026",
		metadata: {},
		status: "active",
		...overrides,
	} as OsWorkspaceResource;
}

describe("appConnectionRows", () => {
	const manifest = {
		entry: "ui://widgets/mcp-app/acme/r/orders.html",
		capabilities: [],
		resourceGrants: [
			{ slot: "order_sheet", operations: ["read", "write"] },
			{ slot: "team_calendar", operations: ["read"] },
		],
	};

	it("joins each declared slot to the active resource that fills it", () => {
		const rows = appConnectionRows(manifest, [
			resource({ availability: { status: "available" } as never }),
		]);
		expect(rows).toEqual([
			expect.objectContaining({
				slot: "order_sheet",
				label: "Orders 2026",
				operations: ["read", "write"],
				status: "connected",
			}),
			expect.objectContaining({
				slot: "team_calendar",
				label: "Team calendar",
				resource: null,
				status: "not_attached",
			}),
		]);
	});

	it("asks for a connection when the account behind a resource is missing", () => {
		const rows = appConnectionRows(manifest, [
			resource({
				availability: {
					status: "missing_connection",
					reason: "Connect Google Sheets",
				} as never,
			}),
		]);
		expect(rows[0]?.status).toBe("needs_connection");
	});

	it("ignores removed resources and apps without declared resources", () => {
		expect(
			appConnectionRows(manifest, [resource({ status: "removed" })])[0]?.status,
		).toBe("not_attached");
		expect(appConnectionRows({ entry: "x", capabilities: [] }, [])).toEqual([]);
		expect(appConnectionRows(null, [resource()])).toEqual([]);
	});
});
