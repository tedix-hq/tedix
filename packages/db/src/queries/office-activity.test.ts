import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
	type OfficeActivityRow,
	OfficeActivityRowSchema,
} from "@tedix/api-contract/schemas/office-activity";
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
				{ ...row, id: crypto.randomUUID(), sessionKey: `codex:example-${i}` },
				now,
			);
		expect(await readOfficeObservations(db, owner)).toHaveLength(150);
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

	it("combines repeated hook reports per session so supervisor and older rows stay visible", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(userConfigs));
		const db = createDbQueryClient(createD1Facade(sqlite));
		const owner = { organizationId: "example", userId: "ada" };
		const start = Date.parse("2026-11-03T00:00:00.000Z");
		const at = (minutes: number) =>
			new Date(start + minutes * 60_000).toISOString();
		const hook = (minutes: number, extra: Partial<OfficeActivityRow>) =>
			OfficeActivityRowSchema.parse({
				id: crypto.randomUUID(),
				at: at(minutes),
				host: "opencode",
				source: "hook",
				sessionKey: "opencode:ses_example",
				trigger: "PostToolUse",
				reportedState: "working",
				reason: "reported",
				outcome: "observed",
				reporterVersion: "0.19.3",
				workItemId: null,
				...extra,
			});
		const { reportedState: _state, ...base } = hook(1, {});
		const supervisor = OfficeActivityRowSchema.parse({
			...base,
			host: "codex",
			sessionKey: "codex:example",
			source: "supervisor",
			trigger: "reply_drain",
			reason: "delivery_confirmed",
			outcome: "success",
			requestId: crypto.randomUUID(),
			responseId: crypto.randomUUID(),
		});
		const older = hook(0, {
			host: "claude-code",
			sessionKey: "claude-code:older",
		});
		await recordOfficeObservation(db, owner, older, at(0));
		await recordOfficeObservation(db, owner, supervisor, at(1));
		// One busy OpenCode lane: permission and tool reports every few seconds.
		for (let i = 0; i < 60; i++)
			await recordOfficeObservation(
				db,
				owner,
				hook(2 + i / 20, {
					trigger: i % 2 ? "PostToolUse" : "PermissionRequest",
					occurrences: 2,
				}),
				at(2 + i / 20),
			);
		const merged = (await readOfficeObservations(
			db,
			owner,
		)) as OfficeActivityRow[];
		expect(merged.map((row) => row.id).slice(-2)).toEqual([
			supervisor.id,
			older.id,
		]);
		expect(merged.find((row) => row.id === supervisor.id)).toEqual(supervisor);
		expect(
			merged
				.filter((row) => row.sessionKey === "opencode:ses_example")
				.map((row) => [row.trigger, row.occurrences, row.firstAt, row.at]),
		).toEqual([
			["PostToolUse", 60, at(2.05), at(2 + 59 / 20)],
			["PermissionRequest", 60, at(2), at(2 + 58 / 20)],
		]);
		// Many other sessions fill the hook share but cannot evict the supervisor.
		for (let i = 0; i < 160; i++)
			await recordOfficeObservation(
				db,
				owner,
				hook(20 + i / 60, { sessionKey: `opencode:ses_other${i}` }),
				at(20 + i / 60),
			);
		const rows = (await readOfficeObservations(
			db,
			owner,
		)) as OfficeActivityRow[];
		expect(rows.filter((row) => row.source === "hook")).toHaveLength(150);
		expect(rows.find((row) => row.id === supervisor.id)).toEqual(supervisor);
		sqlite.close();
	}, 60_000);
});
