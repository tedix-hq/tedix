import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { bindTestContexts } from "../test-context";
import { appAdaptersContractRouter } from "./app-adapters";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const APP_ID = "53146845-24c0-4e89-b681-9309a98156a3";

const { userContext, apiKeyContext } = bindTestContexts({
	organizationId: ORGANIZATION_ID,
	url: "https://api.tedix.test/rpc/app-adapters",
});

describe("app-adapters authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: userContext({ permissions: [] }),
		});

		await expect(client.list({ appId: APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: apiKeyContext({ scopes: [] }),
		});

		await expect(
			client.get({ appId: APP_ID, adapterId: "adapter-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:update permission for human mutations", async () => {
		const client = createRouterClient(appAdaptersContractRouter, {
			context: userContext({ permissions: ["apps:read"] }),
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
			context: apiKeyContext({ scopes: ["apps:read"] }),
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
