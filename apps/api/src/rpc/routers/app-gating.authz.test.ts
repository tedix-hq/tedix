import { createRouterClient } from "@orpc/server";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { describe, expect, it } from "vite-plus/test";
import { bindTestContexts } from "../test-context";
import { appGatingContractRouter } from "./app-gating";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const APP_ID = "53146845-24c0-4e89-b681-9309a98156a3";

const { userContext, apiKeyContext } = bindTestContexts({
	organizationId: ORGANIZATION_ID,
	url: "https://api.tedix.test/rpc/app-gating",
});

it.each(["d1", "postgres"] as const)(
	"reads eligibility through the request's %s client",
	async (dialect) => {
		const sqlite = dialect === "d1" ? new DatabaseSync(":memory:") : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		try {
			const ddl = `
				CREATE TABLE apps (id text PRIMARY KEY, gating_metadata text);
				CREATE TABLE app_tools (
					app_id text, tool_id text, enabled boolean,
					review_state text, review_pending text
				);
				INSERT INTO apps VALUES ('${APP_ID}', NULL);
				INSERT INTO app_tools VALUES
					('${APP_ID}', 'live_tool', true, 'live', NULL),
					('${APP_ID}', 'disabled_tool', false, 'live', NULL),
					('${APP_ID}', 'unapproved_tool', true, 'pending', NULL);
			`;
			if (sqlite) sqlite.exec(ddl);
			if (pg) await pg.engine.exec(ddl);
			const db = pg?.db ?? createDbClient(createD1Facade(sqlite!));
			const client = createRouterClient(appGatingContractRouter, {
				context: userContext({
					permissions: ["apps:read"],
					db,
					env: {
						CORE_STORE: dialect,
						DB: {
							prepare() {
								throw new Error("Use the request client, not env.DB");
							},
						},
					} as CloudflareEnv,
				}),
			});
			await expect(
				client.eligibility({ appId: APP_ID }),
			).resolves.toMatchObject({
				eligible: true,
				availableTools: ["live_tool"],
			});
		} finally {
			sqlite?.close();
			await pg?.close();
		}
	},
);

describe("app-gating authorization-plane composition", () => {
	it("requires apps:read permission for human reads", async () => {
		const client = createRouterClient(appGatingContractRouter, {
			context: userContext({ permissions: [] }),
		});

		await expect(client.eligibility({ appId: APP_ID })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("requires apps:read scope for machine reads", async () => {
		const client = createRouterClient(appGatingContractRouter, {
			context: apiKeyContext({ scopes: [] }),
		});

		await expect(client.installedEligibility({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
