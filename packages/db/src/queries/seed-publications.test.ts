import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { agentTurnDefaults } from "@tedix/api-contract/test/agent-turn-defaults";
import { createDbClient } from "../client";
import { policyPacks } from "../schema/control-plane";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getAgentTurnDefaults } from "./agent-turn-defaults";
import { getWorkOnboarding } from "./work-onboarding";

const cases = [
	{
		slug: "agent-turn-defaults",
		section: "agentTurnDefaults",
		value: agentTurnDefaults(),
		read: getAgentTurnDefaults,
	},
	{
		slug: "work-onboarding",
		section: "workOnboarding",
		value: { version: 1, definition: { gadgets: [], requirements: null } },
		read: getWorkOnboarding,
	},
];
for (const c of cases)
	describe(c.slug, () => {
		function fixture() {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec(schemaDdl(organizations, policyPacks));
			const db = createDbClient(createD1Facade(sqlite));
			const publish = (
				version: number,
				status = "active",
				value: unknown = c.value,
			) =>
				db.insert(policyPacks).values({
					id: `example-${version}`,
					name: "Example",
					slug: c.slug,
					scope: "system",
					target: "shared",
					status: status as "active",
					version,
					publishedAt: "2026-01-01T00:00:00Z",
					publishedBy: "example-admin",
					definition: { [c.section]: value } as never,
				});
			return { sqlite, db, publish };
		}
		it("requires configuration and reads the exact published snapshot", async () => {
			const f = fixture();
			await expect(c.read(f.db)).rejects.toThrow();
			await f.publish(1);
			expect(await c.read(f.db)).toEqual(c.value);
		});
		it.each(["draft", "archived"])(
			"does not resurrect an older publication behind a %s head",
			async (status) => {
				const f = fixture();
				await f.publish(1);
				await f.publish(2, status);
				await expect(c.read(f.db)).rejects.toThrow();
			},
		);
		it("rejects a malformed newest head", async () => {
			const f = fixture();
			await f.publish(1);
			await f.publish(2, "active", {});
			await expect(c.read(f.db)).rejects.toThrow();
		});
		it("rejects organization-owned and unpublished system rows", async () => {
			const f = fixture();
			await f.publish(1);
			await f.db
				.insert(organizations)
				.values({ id: "fictional-org", name: "Fictional", slug: "fictional" });
			f.sqlite.exec("UPDATE policy_packs SET organization_id='fictional-org'");
			await expect(c.read(f.db)).rejects.toThrow();
			f.sqlite.exec(
				"UPDATE policy_packs SET organization_id=NULL,published_by=NULL",
			);
			await expect(c.read(f.db)).rejects.toThrow();
		});
	});
