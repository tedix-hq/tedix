import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bindTestContexts } from "../test-context";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const OWN_APP_ID = "3f0a1c52-7d7e-4a0b-9d0e-5b3a6c7d8e9f";
const FOREIGN_APP_ID = "7c1d2f60-93a4-4b7e-8a55-2f0d6c1e9b31";
const SOURCE_ID = "a4e1b7c8-2d3f-4a5b-8c6d-7e8f9a0b1c2d";

const deleteContentSource = vi.fn(async () => true);

vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: async (_db: unknown, appId: string) => ({
		id: appId,
		organizationId:
			appId === OWN_APP_ID
				? ORGANIZATION_ID
				: "9d8c7b6a-5e4f-4d3c-8b2a-1f0e9d8c7b6a",
	}),
}));
vi.mock("@tedix/db/queries/content-sources", () => ({
	createContentSource: vi.fn(),
	deleteContentSource,
	getContentSource: vi.fn(),
	listContentSourceDocumentsByObjectKeys: vi.fn(),
	listContentSources: vi.fn(),
	updateContentSourceIngestStatus: vi.fn(),
}));

const { contentContractRouter } = await import("./content");

const { userContext } = bindTestContexts({
	organizationId: ORGANIZATION_ID,
	url: "https://api.tedix.test/rpc/content",
	env: { ENVIRONMENT: "test", DB: {} } as unknown as CloudflareEnv,
});

describe("content.removeSource", () => {
	const client = createRouterClient(contentContractRouter, {
		context: userContext({
			permissions: ["apps:read", "apps:update"],
			userRole: "admin",
		}),
	});
	beforeEach(() => deleteContentSource.mockClear());

	it("refuses a source under another organization's app", async () => {
		await expect(
			client.removeSource({ appId: FOREIGN_APP_ID, sourceId: SOURCE_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(deleteContentSource).not.toHaveBeenCalled();
	});

	it("removes a source under the caller's own app", async () => {
		await expect(
			client.removeSource({ appId: OWN_APP_ID, sourceId: SOURCE_ID }),
		).resolves.toEqual({ success: true });
		expect(deleteContentSource).toHaveBeenCalledTimes(1);
	});
});
