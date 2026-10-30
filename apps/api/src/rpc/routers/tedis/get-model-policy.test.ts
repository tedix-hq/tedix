import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	modelCatalogEntry,
	modelCatalogConfig,
} from "@tedix/api-contract/test/model-catalog";
import type { BaseContext } from "../../orpc";
const records = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("@tedix/db/queries/model-catalog", () => ({
	getModelCatalogConfig: async () =>
		modelCatalogConfig([
			modelCatalogEntry("cloudflare/auto"),
			modelCatalogEntry("azure-openai/sample-model"),
		]),
}));
vi.mock("@tedix/db/queries/control-plane/definitions", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getRuntimeProfileById: records.profile,
}));
vi.mock("./helpers", async (original) => ({
	...(await original<Record<string, unknown>>()),
	requireTediAccess: async () => ({
		id: "11111111-1111-4111-8111-111111111111",
		organizationId: "org-caller",
		runtimeProfileId: "profile-example",
		runtimeOverrides: {},
	}),
}));
import { getModelPolicy } from "./config";
const context = {
	authType: "user",
	db: {},
	env: {},
	headers: new Headers(),
	organizationId: "org-caller",
	user: { sub: "caller", permissions: ["tedis:read", "apps:read"], roles: [] },
} as unknown as BaseContext;
const client = createRouterClient({ read: getModelPolicy }, { context });
describe("runtime profile model ownership", () => {
	it.each([null, "org-caller", "org-other"])(
		"reads profile model/generation only for owner %s",
		async (owner) => {
			records.profile.mockResolvedValue({
				organizationId: owner,
				config: {
					modelPolicy: {
						chatModelRef: "azure-openai/sample-model",
						cronModelRef: "azure-openai/sample-model",
						synthesisModelRef: "azure-openai/sample-model",
						generation: { chat: { maxOutputTokens: 2048 } },
					},
				},
			});
			const policy = await client.read({
				tediId: "11111111-1111-4111-8111-111111111111",
			});
			expect(policy.chatModelRef).toBe(
				owner === "org-other" ? "cloudflare/auto" : "azure-openai/sample-model",
			);
			expect(policy.generation).toEqual(
				owner === "org-other" ? undefined : { chat: { maxOutputTokens: 2048 } },
			);
			expect(policy.synthesisModelRef).toBe(
				owner === "org-other" ? undefined : "azure-openai/sample-model",
			);
		},
	);
});
