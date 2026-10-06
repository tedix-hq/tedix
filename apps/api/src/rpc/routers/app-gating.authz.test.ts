import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { appGatingContractRouter } from "./app-gating";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const APP_ID = "53146845-24c0-4e89-b681-9309a98156a3";

function userContext(permissions: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/app-gating"),
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
		url: new URL("https://api.tedix.test/rpc/app-gating"),
	} as BaseContext;
}

describe("app-gating authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(appGatingContractRouter, {
			context: userContext([]),
		});

		await expect(client.eligibility({ appId: APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(appGatingContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(client.installedEligibility({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
