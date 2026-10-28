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
		"server.js": `export class App { constructor(ctx, env) { this.env = env; } read() { return this.env.TEDIX.skillsRead(${JSON.stringify(slot)}, {view: "run", runId: "fixture-run"}); } }`,
	};
	const { token } = await mintWorkspaceAppSession("fictional-app-test-key", {
		organizationId: "fictional-org",
		workspaceId,
		gadgetId: crypto.randomUUID(),
		revisionId: crypto.randomUUID(),
		revision: 1,
		role,
		principal: { kind: "user", id: "fictional-member" },
		grants: [{ slot: "research", operations: ["skills.read"] }],
		codeDigest: await appRuntimeCodeDigest(files),
	});
	return host.call({ session: token, files, method: "read", args: [] });
}

describe("runtime skill evidence capability", () => {
	it.each(["use", "build"] as const)(
		"lets a %s caller read through a granted skill slot",
		async (role) => {
			expect(await invoke("research", role)).toEqual({
				run: { id: "fixture-run" },
			});
		},
	);
	it("refuses ungranted slots and viewer calls", async () => {
		await expect(invoke("other")).rejects.toThrow("App capability denied");
		await expect(invoke("research", "viewer")).rejects.toThrow(
			"requires use access",
		);
	});
});
