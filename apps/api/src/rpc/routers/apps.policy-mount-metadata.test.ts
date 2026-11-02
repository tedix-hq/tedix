import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bindTestContexts } from "../test-context";

const reads = vi.hoisted(() => ({ metadata: vi.fn(), full: vi.fn() }));
vi.mock("@tedix/db/queries/app-records", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getAppPolicyMountMetadataForOrganization: reads.metadata,
	getAppByIdWithToolsForOrganization: reads.full,
}));
import { appsContractRouter } from "./apps";

const appId = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const { userContext, apiKeyContext } = bindTestContexts({
	url: "https://api.example/rpc/apps",
	organizationId: "10000000-0000-4000-8000-000000000001",
});
const client = () =>
	createRouterClient(appsContractRouter, {
		context: userContext({ permissions: ["apps:read"] }),
	});
beforeEach(() => {
	reads.metadata.mockReset().mockResolvedValue(null);
	reads.full.mockReset().mockResolvedValue(null);
});

describe("policy mount metadata boundary", () => {
	it("binds both reads to the caller organization and forwards the narrow tool selection", async () => {
		expect(await client().getPolicyMountMetadata({ appId })).toEqual({
			app: null,
			tools: [],
		});
		expect(reads.metadata).toHaveBeenCalledWith(
			expect.anything(),
			appId,
			"10000000-0000-4000-8000-000000000001",
		);
		expect(
			await client().getByIdWithTools({ appId, toolIds: ["get_work"] }),
		).toEqual({ app: null, tools: [] });
		expect(reads.full).toHaveBeenCalledWith(
			expect.anything(),
			appId,
			"10000000-0000-4000-8000-000000000001",
			{
				toolIds: ["get_work"],
			},
		);
	});

	it("returns only mount metadata and enabled row identities", async () => {
		const result = {
			app: {
				id: appId,
				slug: "fictional-gateway",
				organizationId: "10000000-0000-4000-8000-000000000001",
				metadata: null,
			},
			tools: [{ id: "row", toolId: "get_work" }],
		};
		reads.metadata.mockResolvedValue(result);
		expect(await client().getPolicyMountMetadata({ appId })).toEqual(result);
		expect(reads.full).not.toHaveBeenCalled();
	});

	it("requires apps:read on both authorization planes", async () => {
		for (const context of [
			userContext({ permissions: [] }),
			apiKeyContext({ scopes: [] }),
		]) {
			await expect(
				createRouterClient(appsContractRouter, {
					context,
				}).getPolicyMountMetadata({ appId }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(reads.metadata).not.toHaveBeenCalled();
	});

	it("rejects an empty tool selection instead of widening it to the full surface", async () => {
		await expect(
			client().getByIdWithTools({ appId, toolIds: [] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(reads.full).not.toHaveBeenCalled();
	});
});
