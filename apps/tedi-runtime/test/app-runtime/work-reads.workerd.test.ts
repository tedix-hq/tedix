import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";

async function invoke(slot: string, role: "build" | "use" | "viewer" = "use") {
	const workspaceId = crypto.randomUUID();
	const host = (
		env as unknown as {
			WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
		}
	).WORKSPACE_APP_HOST.getByName(`fictional-org:${workspaceId}`);
	const files = {
		"client.js": "",
		"server.js": `export class App { constructor(ctx, env) { this.env = env; } read() { return this.env.TEDIX.workRead(${JSON.stringify(slot)}, {limit: 10}); } }`,
	};
	const { token } = await mintWorkspaceAppSession("fictional-app-test-key", {
		organizationId: "fictional-org",
		workspaceId,
		gadgetId: crypto.randomUUID(),
		revisionId: crypto.randomUUID(),
		revision: 1,
		role,
		principal: { kind: "user", id: "fictional-member" },
		grants: [{ slot: "board", operations: ["work.read"] }],
		codeDigest: await appRuntimeCodeDigest(files),
	});
	return host.call({ session: token, files, method: "read", args: [] });
}

describe("runtime live Work board capability", () => {
	it.each(["use", "build"] as const)(
		"lets a %s caller read through a granted project slot",
		async (role) => {
			expect(await invoke("board", role)).toEqual({
				rows: [{ id: "fixture-item" }],
			});
		},
	);
	it("refuses ungranted slots and viewer calls", async () => {
		await expect(invoke("other")).rejects.toThrow("App capability denied");
		await expect(invoke("board", "viewer")).rejects.toThrow(
			"requires use access",
		);
	});
});
