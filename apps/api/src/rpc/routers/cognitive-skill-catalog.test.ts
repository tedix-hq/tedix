/**
 * `skills.getForMcp` reads skills as the calling tedi: a tedi loads its own
 * tedi-owned skill without restating its id, and cannot read as another tedi.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { skillEntries } from "@tedix/db/schema/cognitive";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { skillsGetForMcp } from "./cognitive-skill-catalog";

const ORG_ID = "org-fixture";
const CTO_TEDI_ID = "tedi-cto";
const OTHER_TEDI_ID = "tedi-other";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(skillEntries));
	sqlite
		.prepare(
			"INSERT INTO skill_entries (id,organization_id,tedi_id,slug,title,content,visibility) VALUES (?,?,?,?,?,?,?)",
		)
		.run(
			"skill-1",
			ORG_ID,
			CTO_TEDI_ID,
			"daily-intake",
			"Daily intake",
			"# Daily intake",
			"private",
		);
	const facade = createD1Facade(sqlite);
	const tedi = (tediId: string) =>
		createRouterClient(
			{ getForMcp: skillsGetForMcp },
			{
				context: {
					db: createDbClient(facade) as BaseContext["db"],
					env: { ENVIRONMENT: "test", DB: facade } as unknown as CloudflareEnv,
					organizationId: ORG_ID,
					url: new URL("https://api.tedix.test/rpc/skills/getForMcp"),
					headers: new Headers({
						"X-Service-Binding": "true",
						"X-Tedix-Tedi-Id": tediId,
						"X-Tedix-Tedi-Scopes": "tedis:read",
					}),
				} as BaseContext,
			},
		);
	return { tedi };
}

describe("skills.getForMcp", () => {
	it("returns a tedi's own skill when the tedi omits tediId", async () => {
		const { tedi } = fixture();
		const result = await tedi(CTO_TEDI_ID).getForMcp({ slug: "daily-intake" });
		expect(result.entry?.id).toBe("skill-1");
	});

	it("does not expose a tedi's private skill to another tedi", async () => {
		const { tedi } = fixture();
		const result = await tedi(OTHER_TEDI_ID).getForMcp({
			slug: "daily-intake",
		});
		expect(result.entry).toBeNull();
	});

	it("rejects a tedi that asks to read as another tedi", async () => {
		const { tedi } = fixture();
		await expect(
			tedi(OTHER_TEDI_ID).getForMcp({
				slug: "daily-intake",
				tediId: CTO_TEDI_ID,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
