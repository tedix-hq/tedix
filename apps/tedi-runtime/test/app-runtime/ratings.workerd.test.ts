import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";

describe("app ratings in Worker Loader", () => {
	it("lets a use reviewer persist ratings with manifest config in an isolated app", async () => {
		const workspaceId = crypto.randomUUID();
		const host = (
			env as unknown as {
				WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
			}
		).WORKSPACE_APP_HOST.getByName(`fictional-org:${workspaceId}`);
		const files = {
			"client.js": "",
			"server.js": `
export class App {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async rate(input) {
    const ratings = this.ctx.storage.kv.get('ratings') ?? {};
    const saved = { decision: input.decision, tags: input.tags.filter(tag => this.env.CONFIG.settings.tags.includes(tag)) };
    ratings[input.cardId] = saved;
    this.ctx.storage.kv.put('ratings', ratings);
    return saved;
  }
  ratings() { return this.ctx.storage.kv.get('ratings') ?? {}; }
}`,
		};
		const { token } = await mintWorkspaceAppSession("fictional-app-test-key", {
			organizationId: "fictional-org",
			workspaceId,
			gadgetId: crypto.randomUUID(),
			revisionId: crypto.randomUUID(),
			revision: 1,
			role: "use",
			principal: { kind: "user", id: "fictional-reviewer" },
			grants: [],
			codeDigest: await appRuntimeCodeDigest(files),
			config: { version: 1, settings: { tags: ["Relevant"] } },
		});
		const invocation = { session: token, files };
		expect(
			await host.call({ ...invocation, method: "ratings", args: [] }),
		).toEqual({});
		const saved = await host.call({
			...invocation,
			method: "rate",
			args: [
				{ cardId: "one", decision: "Hilfreich", tags: ["Relevant", "Unknown"] },
			],
		});
		expect(saved).toEqual({ decision: "Hilfreich", tags: ["Relevant"] });
		expect(
			await host.call({ ...invocation, method: "ratings", args: [] }),
		).toEqual({ one: saved });
	});
});
