import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { skillRuns } from "../schema/cognitive";
import { gatewayChangeRecordCheckpoints } from "../schema/gateway-change-records";
import { LOGS_DB_TABLES } from "../schema/logs-db";
import { tedis } from "../schema/tedis";
import { workEvents } from "../schema/work-items";
import { schemaDdl } from "../test/schema-ddl";
import {
	createHistoryReader,
	HISTORY_TABLES,
	type HistoryRow,
} from "./history-export";

it("can page raw history against the actual main and logs schemas", async () => {
	const sqlite = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	try {
		sqlite.exec(
			schemaDdl(
				...LOGS_DB_TABLES,
				gatewayChangeRecordCheckpoints,
				workEvents,
				skillRuns,
				tedis,
			),
		);
		const reader = createHistoryReader(
			async (query, params) =>
				sqlite.prepare(query).all(...params) as HistoryRow[],
		);
		expect(await reader.owners("skill_runs", "org_example")).toEqual([]);
		expect(await reader.owners("tedis", "org_example")).toEqual([]);
		for (const table of HISTORY_TABLES) {
			const highWater = await reader.highWater(table);
			expect(
				await reader.page(table, {
					organization: "org_example",
					from: "2026-01-01T00:00:00Z",
					to: "2026-02-01T00:00:00Z",
					after: 0,
					highWater,
					owners: [],
				}),
			).toEqual([]);
		}
	} finally {
		sqlite.close();
	}
});
