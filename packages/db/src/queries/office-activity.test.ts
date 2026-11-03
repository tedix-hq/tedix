import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { OfficeActivityRowSchema } from "@tedix/api-contract/schemas/office-activity";
import { createDbQueryClient } from "../query-client";
import { userConfigs } from "../schema/user-configs";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	recordOfficeObservation,
	readOfficeObservations,
	pruneOfficeObservations,
	pruneExpiredOfficeSnapshots,
} from "./office-activity";

describe("private bounded Office history", () => {
	it("atomically merges interleaved reports, deduplicates IDs, caps history and isolates owner/tenant", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(userConfigs));
		const db = createDbQueryClient(createD1Facade(sqlite));
		const owner = { organizationId: "example", userId: "ada" };
		const now = "2026-11-03T12:00:00.000Z";
		const row = OfficeActivityRowSchema.parse({
			id: crypto.randomUUID(),
			at: now,
			host: "codex",
			source: "hook",
			sessionKey: "codex:example",
			trigger: "Stop",
			reason: "reported",
			outcome: "observed",
			reporterVersion: "0.19.3",
			workItemId: null,
		});
		await recordOfficeObservation(db, owner, row, now);
		await recordOfficeObservation(db, owner, row, now);
		expect(await readOfficeObservations(db, owner)).toHaveLength(1);
		for (let i = 0; i < 210; i++)
			await recordOfficeObservation(
				db,
				owner,
				{ ...row, id: crypto.randomUUID() },
				now,
			);
		expect(await readOfficeObservations(db, owner)).toHaveLength(200);
		expect(
			await readOfficeObservations(db, { ...owner, userId: "grace" }),
		).toEqual([]);
		expect(
			await readOfficeObservations(db, { ...owner, organizationId: "other" }),
		).toEqual([]);
		await recordOfficeObservation(
			db,
			{ ...owner, organizationId: "other" },
			row,
			now,
		);
		await pruneOfficeObservations(db, owner, "2026-11-05T12:00:00.000Z");
		expect(await readOfficeObservations(db, owner)).toEqual([]);
		expect(
			await readOfficeObservations(db, { ...owner, organizationId: "other" }),
		).toHaveLength(1);
		await db.insert(userConfigs).values({
			id: "preferences",
			userId: "ada",
			namespace: "other.preferences",
			key: "example",
			value: {},
			updatedAt: now,
		});
		expect(
			await pruneExpiredOfficeSnapshots(db, "2026-11-05T12:00:00.000Z"),
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM user_configs WHERE namespace='other.preferences'",
				)
				.get(),
		).toEqual({ n: 1 });
		sqlite.close();
	});
});
