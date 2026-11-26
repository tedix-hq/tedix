import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getBackgroundMemoryChangeSlotsRemaining,
	reserveBackgroundMemoryChangeSlots,
} from "./background-memory-budget";

it("reserves background memory change slots atomically, logs the cap once, and resets on a new UTC day", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(organizations));
		const db = createDbQueryClient(createD1Facade(sqlite));
		await db.insert(organizations).values([
			{
				id: "fictional-lighthouse",
				name: "Lighthouse",
				slug: "lighthouse",
				metadata: { industryVertical: "fictional" },
			},
			{ id: "fictional-harbor", name: "Harbor", slug: "harbor" },
		]);
		const input = {
			organizationId: "fictional-lighthouse",
			maxSlots: 3,
			dailyLimit: 5,
		};
		expect(await reserveBackgroundMemoryChangeSlots(db, input)).toEqual({
			reserved: 3,
			capReached: false,
			logCap: false,
		});
		expect(
			await getBackgroundMemoryChangeSlotsRemaining(db, {
				organizationId: input.organizationId,
				dailyLimit: 5,
			}),
		).toBe(2);
		expect(await reserveBackgroundMemoryChangeSlots(db, input)).toEqual({
			reserved: 2,
			capReached: true,
			logCap: true,
		});
		expect(await reserveBackgroundMemoryChangeSlots(db, input)).toEqual({
			reserved: 0,
			capReached: true,
			logCap: false,
		});
		const metadata = () =>
			JSON.parse(
				String(
					sqlite
						.prepare(
							"SELECT metadata FROM organizations WHERE id='fictional-lighthouse'",
						)
						.get()!.metadata,
				),
			);
		expect(metadata()).toMatchObject({
			industryVertical: "fictional",
			organizationDailyBudgets: {
				backgroundMemoryChanges: { reserved: 5, capLogged: 1 },
			},
		});
		expect(
			await getBackgroundMemoryChangeSlotsRemaining(db, {
				organizationId: "fictional-harbor",
				dailyLimit: 5,
			}),
		).toBe(5);
		expect(
			await reserveBackgroundMemoryChangeSlots(db, {
				...input,
				organizationId: "missing",
			}),
		).toEqual({ reserved: 0, capReached: true, logCap: false });
		sqlite.exec(
			"UPDATE organizations SET metadata=json_set(metadata,'$.organizationDailyBudgets.backgroundMemoryChanges.reserved','corrupt') WHERE id='fictional-lighthouse'",
		);
		expect(await reserveBackgroundMemoryChangeSlots(db, input)).toEqual({
			reserved: 0,
			capReached: true,
			logCap: false,
		});
		expect(
			await getBackgroundMemoryChangeSlotsRemaining(db, {
				organizationId: input.organizationId,
				dailyLimit: 5,
			}),
		).toBe(0);
		sqlite.exec(
			"UPDATE organizations SET metadata=json_set(metadata,'$.organizationDailyBudgets.backgroundMemoryChanges.day','2000-01-01','$.organizationDailyBudgets.backgroundMemoryChanges.reserved',0,'$.organizationDailyBudgets.backgroundMemoryChanges.capLogged',0) WHERE id='fictional-lighthouse'",
		);
		expect(await reserveBackgroundMemoryChangeSlots(db, input)).toEqual({
			reserved: 3,
			capReached: false,
			logCap: false,
		});
	} finally {
		sqlite.close();
	}
});
