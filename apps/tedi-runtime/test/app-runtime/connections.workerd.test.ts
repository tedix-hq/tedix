import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";

async function invoke(
	decision: string,
	slot = "calendar",
	role: "build" | "use" = "build",
) {
	const workspaceId = crypto.randomUUID();
	const namespace = (
		env as unknown as {
			WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
		}
	).WORKSPACE_APP_HOST;
	const host = namespace.getByName(`fictional-org:${workspaceId}`);
	const files = {
		"client.js": "",
		"server.js": `import { DurableObject } from 'cloudflare:workers';
export class App extends DurableObject {
  call() { return this.env.TEDIX.connectionsCall(${JSON.stringify(slot)}, {decision: ${JSON.stringify(decision)}}); }
}`,
	};
	const { token } = await mintWorkspaceAppSession("fictional-app-test-key", {
		organizationId: "fictional-org",
		workspaceId,
		gadgetId: crypto.randomUUID(),
		revisionId: crypto.randomUUID(),
		revision: 1,
		role,
		principal: { kind: "user", id: "fictional-member" },
		grants: [{ slot: "calendar", operations: ["connections.call"] }],
		codeDigest: await appRuntimeCodeDigest(files),
	});
	return host.call({ session: token, files, method: "call", args: [] });
}

describe("runtime connections capability through workerd", () => {
	it("returns only the approved provider result across the RPC capability", async () => {
		expect(await invoke("approved")).toEqual({ events: ["fixture-event"] });
	});
	it.each(["pending", "rejected", "expired"])(
		"preserves the API's %s decision",
		async (status) => {
			expect(await invoke(status)).toEqual({
				approval: { approved: false, status },
			});
		},
	);
	it("propagates revocation and refuses an ungranted slot", async () => {
		await expect(invoke("revoked")).rejects.toThrow();
		await expect(invoke("approved", "other-slot")).rejects.toThrow(
			"App capability denied",
		);
	});
	it("does not give a use session a connection capability", async () => {
		await expect(invoke("approved", "calendar", "use")).rejects.toThrow(
			/connectionsCall/,
		);
	});
});
