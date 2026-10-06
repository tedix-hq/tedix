import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	chatDispatchIdempotency,
	tediRuntimeEvents,
} from "@tedix/db/schema/cognitive-runtime";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "@tedix/db/schema/control-plane";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { readSingleChildRunSummary } from "./child-run-reads";

describe("delegated child observation identity", () => {
	it("requires exact organization, tedi and run even after run.started leaves the recent window", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(
				schemaDdl(
					organizations,
					runtimeProfiles,
					policyPacks,
					workspaceTemplateSets,
					tedis,
					tediRuntimeEvents,
					chatDispatchIdempotency,
				),
			);
			sqlite.exec(`
				INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'One', 'one'), ('org-2', 'Two', 'two');
				INSERT INTO tedis (id, organization_id, name, slug) VALUES ('tedi-1', 'org-1', 'One', 'one'), ('tedi-2', 'org-1', 'Two', 'two');
			`);
			const db = createDbClient(createD1Facade(sqlite));
			const context = { db } as BaseContext;
			const at = "2026-09-18T12:00:00.000Z";
			const ref = {
				organizationId: "org-1",
				tediId: "tedi-1",
				runId: "child-1",
			};
			for (const [index, changed] of [
				{ organizationId: "org-2" },
				{ tediId: "tedi-2" },
				{ runId: "child-2" },
			].entries())
				await db.insert(tediRuntimeEvents).values({
					...ref,
					id: `unrelated-${index}`,
					kind: "message.phase",
					runtimeBackend: "cloudflare-agents",
					createdAt: at,
					...changed,
				});
			expect(await readSingleChildRunSummary(context, ref)).toBeNull();
			await db.insert(tediRuntimeEvents).values({
				...ref,
				id: "started",
				kind: "run.started",
				runtimeBackend: "cloudflare-agents",
				createdAt: "2026-09-18T10:00:00.000Z",
			});
			for (let index = 0; index < 30; index++)
				await db.insert(tediRuntimeEvents).values({
					...ref,
					id: `observation-${index}`,
					kind: "message.phase",
					runtimeBackend: "cloudflare-agents",
					createdAt: new Date(Date.parse(at) - index * 120_000).toISOString(),
					payload: {
						phase: "waiting_for_computer",
						source: "native_command_observation",
						executionIds: ["execution-1"],
					},
				});
			expect(await readSingleChildRunSummary(context, ref)).toMatchObject({
				childRunStatus: "queued",
				childRunEventCount: 25,
				childRunLatestEventKind: "message.phase",
				childRunLatestEventAt: at,
			});
		} finally {
			sqlite.close();
		}
	});
});
