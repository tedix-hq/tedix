import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { userConfigs } from "@tedix/db/schema/user-configs";
import {
	automaticFilingEnabled,
	requestFilingSettings,
	setAutomaticFiling,
} from "./request-filing-settings";
it("sharing requires an explicit choice scoped to both the owner and the organization", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(userConfigs));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const owner = { organizationId: "org-example", userId: "user-ada" };
	expect(await automaticFilingEnabled(db, owner)).toBe(false);
	await setAutomaticFiling(db, owner, true, "project-intake");
	expect(await automaticFilingEnabled(db, owner)).toBe(true);
	expect(
		await automaticFilingEnabled(db, { ...owner, organizationId: "org-other" }),
	).toBe(false);
	expect(
		await automaticFilingEnabled(db, { ...owner, userId: "user-grace" }),
	).toBe(false);
	await setAutomaticFiling(db, owner, false);
	expect(await automaticFilingEnabled(db, owner)).toBe(false);
	expect((await requestFilingSettings(db, owner)).intakeProjectId).toBe(
		"project-intake",
	);
	expect(
		(await requestFilingSettings(db, { ...owner, userId: "user-grace" }))
			.intakeProjectId,
	).toBeNull();
	await setAutomaticFiling(db, owner, true, null);
	expect((await requestFilingSettings(db, owner)).intakeProjectId).toBeNull();
});
