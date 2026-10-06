import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { capabilitiesContractRouter } from "./capabilities";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

function userContext(permissions: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/capabilities"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function apiKeyContext(scopes: string[]): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: ORGANIZATION_ID,
			scopes,
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/capabilities"),
	} as BaseContext;
}

describe("capabilities authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: userContext([]),
		});

		await expect(client.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(client.tree({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires settings:manage permission for human mutations", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: userContext(["apps:read"]),
		});

		await expect(
			client.create({ name: "Governance", paceLayer: "record" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:write scope for machine mutations", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(
			client.create({ name: "Governance", paceLayer: "record" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
