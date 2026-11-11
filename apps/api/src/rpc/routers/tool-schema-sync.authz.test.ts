import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { bindTestContexts } from "../test-context";
import { toolSchemaSyncContractRouter } from "./tool-schema-sync";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const FOREIGN_APP_ID = "7c1d2f60-93a4-4b7e-8a55-2f0d6c1e9b31";

const queued: unknown[] = [];
const env = {
	ENVIRONMENT: "test",
	TEDIX_FLEET_AUTHORITY_MODE: "co-located",
	// Co-located fleet authority only checks that a database is bound.
	DB: {},
	TOOL_SCHEMA_SYNC_WORKFLOW: {
		create: async (input: unknown) => {
			queued.push(input);
			return { id: "workflow-1" };
		},
	},
} as unknown as CloudflareEnv;

const { userContext, apiKeyContext } = bindTestContexts({
	organizationId: ORGANIZATION_ID,
	url: "https://api.tedix.test/rpc/toolSchemaSync",
	env,
});

describe("toolSchemaSync authorization", () => {
	it("refuses an organization admin for another app and for the shared app", async () => {
		const admin = createRouterClient(toolSchemaSyncContractRouter, {
			context: userContext({
				permissions: ["apps:update", "tools:read", "tools:write"],
				userRole: "admin",
			}),
		});
		for (const input of [{ appId: FOREIGN_APP_ID }, {}]) {
			await expect(admin.preview(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(admin.check(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(admin.run(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
		expect(queued).toEqual([]);
	});

	it("refuses an organization API key with tool scopes", async () => {
		const machine = createRouterClient(toolSchemaSyncContractRouter, {
			context: apiKeyContext({
				scopes: ["apps:read", "apps:write", "tools:read", "tools:write"],
			}),
		});
		await expect(machine.run({ appId: FOREIGN_APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(machine.preview({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(queued).toEqual([]);
	});

	it("lets a platform-admin key queue a sync", async () => {
		const operator = createRouterClient(toolSchemaSyncContractRouter, {
			context: apiKeyContext({ scopes: ["platform:admin"] }),
		});
		await expect(
			operator.run({ appId: FOREIGN_APP_ID }),
		).resolves.toMatchObject({ workflowId: "workflow-1", status: "queued" });
		expect(queued).toHaveLength(1);
	});
});
