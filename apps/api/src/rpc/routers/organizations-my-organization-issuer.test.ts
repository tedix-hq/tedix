import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	ensurePersonalOrg: vi.fn(),
}));

vi.mock("@tedix/db/queries/organization-sync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-sync")
	>()),
	ensurePersonalOrg: mocks.ensurePersonalOrg,
}));

const PROJECT_ID = "P2fictional";

function contextWithIssuer(iss: string): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: PROJECT_ID,
			TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
		} as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss,
			permissions: [],
			roles: [],
			sub: "U2fictionaluser",
			email: "person@acme.example",
		},
	} as BaseContext;
}

describe("organizations.getMyOrganization identity issuer", () => {
	beforeEach(() => {
		mocks.ensurePersonalOrg.mockReset();
		// Stop the handler right after the bootstrap call under test.
		mocks.ensurePersonalOrg.mockRejectedValue(new Error("stop"));
	});

	it("binds a Connect (agentic app) token under the project issuer", async () => {
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: contextWithIssuer(
				`https://api.descope.com/v1/apps/agentic/${PROJECT_ID}/RSapp1`,
			),
		});
		await expect(client.getMyOrganization({})).rejects.toThrow("stop");
		expect(mocks.ensurePersonalOrg.mock.calls[0]?.[4]).toBe(
			descopeIssuer(PROJECT_ID),
		);
	});

	it("keeps a project-issued session token's issuer", async () => {
		const { organizationsContractRouter } = await import("./organizations");
		const issuer = `https://api.descope.com/${PROJECT_ID}`;
		const client = createRouterClient(organizationsContractRouter, {
			context: contextWithIssuer(issuer),
		});
		await expect(client.getMyOrganization({})).rejects.toThrow("stop");
		expect(mocks.ensurePersonalOrg.mock.calls[0]?.[4]).toBe(issuer);
	});
});
