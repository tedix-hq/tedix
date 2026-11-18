import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { expect, test } from "vite-plus/test";
import type { WorkspaceEnv } from "../src/env";

test.each([true, false])(
	"opening a store removes only the retired approval key (present: %s)",
	async (hasLegacyRules) => {
		const scope = {
			organizationId: "org_test",
			workspaceId: crypto.randomUUID(),
		};
		const testEnv = env as unknown as WorkspaceEnv;
		const ws = tenantStoreStub(testEnv.WORKSPACE, testEnv, scope);
		const before = await runInDurableObject(ws, async (_instance, state) => {
			await state.storage.put({
				"output-authority": "object",
				"output-import-generation": 3,
				"moved-chat-visible-archives": true,
				"unrelated-setting": { enabled: false, values: [1, "kept"] },
			});
			if (hasLegacyRules)
				await state.storage.put("auto-approval-rules", [
					{ toolName: "example_read" },
				]);
			return state.storage.list();
		});
		const expected = new Map(before);
		expected.delete("auto-approval-rules");

		for (let wake = 0; wake < 2; wake++) {
			await evictDurableObject(ws);
			const response = await ws.fetch("https://workspace/unknown", {
				headers: {
					"X-Workspace-Org": scope.organizationId,
					"X-Workspace-Id": scope.workspaceId,
				},
			});
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not found");
			await runInDurableObject(ws, async (_instance, state) => {
				expect(await state.storage.list()).toEqual(expected);
			});
		}
	},
);
