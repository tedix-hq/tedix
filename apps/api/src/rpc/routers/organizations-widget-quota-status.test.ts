import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	listOrganizationWidgetQuotaStatus: vi.fn(),
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	listOrganizationWidgetQuotaStatus: mocks.listOrganizationWidgetQuotaStatus,
}));

import { organizationsContractRouter } from "./organizations";

const ORGANIZATION_ID = "5eed0026-0000-4000-8000-000000000027";

function userContext(roles: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles,
			sub: "user-1",
		},
		userRole: "owner",
	} as BaseContext;
}

/**
 * A background tedi run reaches apps/api through the MCP edge service binding,
 * which forwards the tedi id and the capability scopes resolved from D1.
 */
function tediContext(tediScopes: string[]): BaseContext {
	return {
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": ORGANIZATION_ID,
			"X-Tedix-Tedi-Id": "d3b0f0a2-51f6-4a7e-9a36-2a8f1f0b1f11",
			...(tediScopes.length > 0
				? { "X-Tedix-Tedi-Scopes": tediScopes.join(" ") }
				: {}),
		}),
		url: new URL("https://api.tedix.test/rpc/organizations"),
	} as unknown as BaseContext;
}

const ROWS = [
	{
		id: "org-set",
		slug: "quota-set",
		name: "Quota set",
		visitorTurnsPerHour: 20,
		originTurnsPerHour: 500,
	},
	{
		id: "org-unset",
		slug: "quota-unset",
		name: "Quota unset",
		visitorTurnsPerHour: null,
		originTurnsPerHour: null,
	},
];

describe("organizations.listWidgetQuotaStatus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listOrganizationWidgetQuotaStatus.mockResolvedValue(ROWS);
	});

	it("returns quota rows to a platform-admin user", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(["platform-admin"]),
		});
		await expect(client.listWidgetQuotaStatus({})).resolves.toEqual({
			organizations: ROWS,
		});
	});

	it("admits a background tedi run holding platform:admin", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: tediContext(["platform:admin"]),
		});
		await expect(client.listWidgetQuotaStatus({})).resolves.toEqual({
			organizations: ROWS,
		});
	});

	it("refuses a tenant admin and a tedi without platform authority", async () => {
		for (const context of [userContext(["org-admin"]), tediContext([])]) {
			const client = createRouterClient(organizationsContractRouter, {
				context,
			});
			await expect(client.listWidgetQuotaStatus({})).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
		expect(mocks.listOrganizationWidgetQuotaStatus).not.toHaveBeenCalled();
	});
});
