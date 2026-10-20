import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { bindTestContexts } from "../test-context";
import { capabilitiesContractRouter } from "./capabilities";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

const { userContext, apiKeyContext } = bindTestContexts({
	organizationId: ORGANIZATION_ID,
	url: "https://api.tedix.test/rpc/capabilities",
});

describe("capabilities authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: userContext({ permissions: [] }),
		});

		await expect(client.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: apiKeyContext({ scopes: [] }),
		});

		await expect(client.tree({})).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("requires settings:manage permission for human mutations", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: userContext({ permissions: ["apps:read"] }),
		});

		await expect(
			client.create({ name: "Governance", paceLayer: "record" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:write scope for machine mutations", async () => {
		const client = createRouterClient(capabilitiesContractRouter, {
			context: apiKeyContext({ scopes: ["apps:read"] }),
		});

		await expect(
			client.create({ name: "Governance", paceLayer: "record" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
