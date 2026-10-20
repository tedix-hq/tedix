import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { bindTestContexts } from "../test-context";
import { adapterBindingsContractRouter } from "./adapter-bindings";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const APP_ID = "53146845-24c0-4e89-b681-9309a98156a3";

const { userContext, apiKeyContext } = bindTestContexts({
	organizationId: ORGANIZATION_ID,
	url: "https://api.tedix.test/rpc/adapter-bindings",
});

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
			context: userContext({ permissions: [] }),
		});

		await expect(client.listByApp({ appId: APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: apiKeyContext({ scopes: [] }),
		});

		await expect(client.get({ bindingId: "binding-1" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:update permission for human writes", async () => {
		const client = createRouterClient(adapterBindingsContractRouter, {
			context: userContext({ permissions: ["apps:read"] }),
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
			context: apiKeyContext({ scopes: ["apps:read"] }),
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
			context: userContext({
				permissions: ["apps:update"],
				userRole: "member",
			}),
		});

		await expect(
			client.deleteByPath({
				adapterId: "adapter-1",
				configPath: "apiKey",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets a scoped machine principal reach tenant-scoped storage checks", async () => {
		const context = apiKeyContext({ scopes: ["apps:write"] });
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
