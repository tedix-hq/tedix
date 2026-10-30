import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));
vi.mock("@tedix/db/queries/role-templates", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/role-templates")
	>()),
	copyPlatformRoleTemplate: mocks.copy,
}));
import { roleTemplatesContractRouter } from "./role-templates";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const SOURCE = "00000000-0000-4000-8000-000000000003";

function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "user",
		organizationId: ORG,
		userRole: "owner",
		user: { sub: "owner", roles: ["owner"], permissions: ["settings:manage"] },
		db: {} as BaseContext["db"],
		env: {} as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc/role-templates"),
		...overrides,
	} as BaseContext;
}

describe("copy platform role template authorization", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.copy.mockResolvedValue({ id: "copy" });
	});

	it("copies only into the verified owner organization", async () => {
		const client = createRouterClient(roleTemplatesContractRouter, {
			context: () => context(),
		});
		await client.copyPlatform({
			sourceTemplateId: SOURCE,
			organizationId: ORG,
		});
		expect(mocks.copy).toHaveBeenCalledWith(expect.anything(), {
			sourceId: SOURCE,
			orgId: ORG,
		});
	});

	it("rejects a different or missing organization", async () => {
		const client = createRouterClient(roleTemplatesContractRouter, {
			context: () => context(),
		});
		await expect(
			client.copyPlatform({
				sourceTemplateId: SOURCE,
				organizationId: OTHER_ORG,
			}),
		).rejects.toThrow();
		const unscoped = createRouterClient(roleTemplatesContractRouter, {
			context: () => context({ organizationId: undefined }),
		});
		await expect(
			unscoped.copyPlatform({
				sourceTemplateId: SOURCE,
				organizationId: OTHER_ORG,
			}),
		).rejects.toThrow();
		expect(mocks.copy).not.toHaveBeenCalled();
	});

	it("rejects non-owner and machine callers even with a governance grant", async () => {
		for (const overrides of [
			{ userRole: "member" } as Partial<BaseContext>,
			{
				authType: "apikey",
				apiKey: { scopes: ["earned-delegation:govern"] },
			} as Partial<BaseContext>,
		]) {
			const client = createRouterClient(roleTemplatesContractRouter, {
				context: () => context(overrides),
			});
			await expect(
				client.copyPlatform({ sourceTemplateId: SOURCE }),
			).rejects.toThrow();
		}
		expect(mocks.copy).not.toHaveBeenCalled();
	});
});
