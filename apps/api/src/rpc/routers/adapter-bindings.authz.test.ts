import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { adapterBindingsContractRouter } from "./adapter-bindings";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const APP_ID = "53146845-24c0-4e89-b681-9309a98156a3";

function userContext(permissions: string[], userRole?: string): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/adapter-bindings"),
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
		...(userRole ? { userRole } : {}),
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
		url: new URL("https://api.tedix.test/rpc/adapter-bindings"),
	} as BaseContext;
}

function notFoundDb(): BaseContext["db"] {
	return {
		query: {
			appAdapters: { findFirst: async () => undefined },
			apps: { findFirst: async () => undefined },
		},
	} as unknown as BaseContext["db"];
}

describe("adapter-bindings authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: userContext([]),
		});

		await expect(client.listByApp({ appId: APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: apiKeyContext([]),
		});

		await expect(client.get({ bindingId: "binding-1" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:update permission for human writes", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: userContext(["apps:read"]),
		});

		await expect(
			client.deleteByPath({
				adapterId: "adapter-1",
				configPath: "apiKey",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:write scope for machine writes", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: apiKeyContext(["apps:read"]),
		});

		await expect(
			client.deleteByPath({
				adapterId: "adapter-1",
				configPath: "apiKey",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("keeps the human admin-or-owner requirement ahead of storage reads", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: userContext(["apps:update"], "member"),
		});

		await expect(
			client.deleteByPath({
				adapterId: "adapter-1",
				configPath: "apiKey",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets a scoped machine principal reach tenant-scoped storage checks", async () => {
		const context = apiKeyContext(["apps:write"]);
		context.db = notFoundDb();
		const client = createRouterClient(adapterBindingsContractRouter, {
			context,
		});

		await expect(
			client.deleteByPath({
				adapterId: "adapter-1",
				configPath: "apiKey",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
