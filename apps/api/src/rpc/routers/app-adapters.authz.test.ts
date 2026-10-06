import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { appAdaptersContractRouter } from "./app-adapters";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const APP_ID = "53146845-24c0-4e89-b681-9309a98156a3";

function userContext(permissions: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/app-adapters"),
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
		url: new URL("https://api.tedix.test/rpc/app-adapters"),
	} as BaseContext;
}

describe("app-adapters authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: userContext([]),
		});

		await expect(client.list({ appId: APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(
			client.get({ appId: APP_ID, adapterId: "adapter-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:update permission for human mutations", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: userContext(["apps:read"]),
		});

		await expect(
			client.create({
				adapterType: "custom",
				appId: APP_ID,
				name: "Governed adapter",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:write scope for machine mutations", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(
			client.update({
				adapterId: "adapter-1",
				appId: APP_ID,
				enabled: true,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
