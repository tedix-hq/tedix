import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { LANE_READY_EXECUTORS } from "@tedix/api-contract/schemas/work-items";
import { createDbQueryClient } from "../../query-client";
import {
	workItems,
	workEvents,
	workAttempts,
	workItemComments,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { updateWorkItemSpecification } from "./crud";

it.each([...LANE_READY_EXECUTORS])(
	"assigning %s through a specification update marks accepted Work ready",
	async (executor) => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(
			schemaDdl(workItems, workEvents, workAttempts, workItemComments),
		);
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,created_at,metadata) VALUES('w','org','T','accepted','2026-10-18T00:00:00.000Z','{}')",
			)
			.run();
		const db = createDbQueryClient(createD1Facade(sqlite));
		const updated = await updateWorkItemSpecification(db, {
			orgId: "org",
			workItemId: "w",
			actor: { type: "user", id: "owner" },
			executor,
		});
		expect(updated.metadata?.laneDispatch).toEqual({ state: "ready" });
	},
);
