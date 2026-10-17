import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { supportConfiguration } from "@tedix/db/schema/support";
import { projects } from "@tedix/db/schema/projects";
import { workItems } from "@tedix/db/schema/work-items";
import { putSupportConfiguration } from "@tedix/db/queries/support";
import { SupportConfigurationSchema } from "@tedix/api-contract/schemas/support";
import { stageSupportEmail } from "./support-email";
describe("support email mapping stub", () => {
	it("deduplicates restricted intake without inferring membership, mirroring a body or waking a tedi", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(schemaDdl(supportConfiguration, projects, workItems));
		const db = createDbClient(createD1Facade(sqlite));
		const org = "11111111-1111-4111-8111-111111111111",
			tedi = "22222222-2222-4222-8222-222222222222";
		await putSupportConfiguration(
			db,
			SupportConfigurationSchema.parse({
				platformOrgId: org,
				supportTediId: tedi,
				adminUserId: "admin",
			}),
			new Date().toISOString(),
		);
		const input = {
			organizationId: org,
			tediId: tedi,
			messageId: "saved-mail-1",
			threadId: "saved-thread",
			subject: "Connection question",
		};
		expect(
			await stageSupportEmail({ db }, { ...input, tediId: "another-tedi" }),
		).toBeNull();
		const id = await stageSupportEmail({ db }, input);
		expect(await stageSupportEmail({ db }, input)).toBe(id);
		expect(
			sqlite
				.prepare(
					"select disposition,accountable_owner_type,accountable_owner_id from work_items",
				)
				.all(),
		).toEqual([
			{
				disposition: "proposed",
				accountable_owner_type: "user",
				accountable_owner_id: "admin",
			},
		]);
	});
});
