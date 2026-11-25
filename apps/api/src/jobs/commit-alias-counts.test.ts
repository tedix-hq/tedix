import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, configureLogStore } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import {
	CommitAliasCountLocationSchema,
	type CommitAliasCountCursor,
} from "@tedix/api-contract/schemas/commit-alias-counts";
import { countCommitAliasPage } from "./commit-alias-counts";

const old = "a".repeat(40);
const canonical = "b".repeat(40);
const repository = "example/project";
const input = { repository, quietHoursUtc: { start: 1, end: 5 } };

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE git_commit_aliases(old_sha TEXT PRIMARY KEY, new_sha TEXT, repository TEXT);
		CREATE TABLE work_attempts(id TEXT PRIMARY KEY, metadata TEXT, runtime_state TEXT);
		CREATE TABLE work_items(id TEXT PRIMARY KEY, metadata TEXT, disposition TEXT, repository_observer INTEGER);
		CREATE TABLE kernel_requests(id TEXT PRIMARY KEY, snapshot TEXT);
		CREATE TABLE external_agent_attributions(id TEXT PRIMARY KEY, target_id TEXT, target_type TEXT);
		CREATE TABLE external_agent_review_evidence(id TEXT PRIMARY KEY, target_id TEXT, repository_version TEXT);
		CREATE TABLE learning_interaction_events(id TEXT PRIMARY KEY, metadata TEXT);
		CREATE TABLE work_interactions(id TEXT PRIMARY KEY, metadata TEXT, status TEXT);
		CREATE TABLE work_item_comments(id TEXT PRIMARY KEY, metadata TEXT);
		CREATE TABLE work_interaction_card_revisions(id TEXT PRIMARY KEY, proposal TEXT);
	`);
	const facade = createD1Facade(sqlite);
	const times: number[] = [];
	const prepare = facade.prepare.bind(facade);
	vi.spyOn(facade, "prepare").mockImplementation((query: string) => {
		expect(query.trim()).toMatch(/^(SELECT|EXPLAIN)\b/i);
		if (!query.trim().startsWith("EXPLAIN")) times.push(Date.now());
		return prepare(query);
	});
	return { sqlite, facade, db: createDbClient(facade), times };
}

async function page(
	db: ReturnType<typeof createDbClient>,
	cursor?: CommitAliasCountCursor,
) {
	const result = countCommitAliasPage(db, { ...input, cursor });
	await vi.runAllTimersAsync();
	return result;
}

describe("paced commit alias count", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("resumes bounded pages, counts rows once, classifies locked rows, and never issues writes", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const f = fixture();
		f.sqlite
			.prepare("INSERT INTO git_commit_aliases VALUES (?, ?, ?)")
			.run(old, canonical, repository);
		const insert = f.sqlite.prepare(
			"INSERT INTO work_attempts VALUES (?, ?, ?)",
		);
		for (let i = 0; i < 201; i++)
			insert.run(
				String(i).padStart(3, "0"),
				JSON.stringify({
					settlement: { commitShas: [old, old] },
					sourceCommit: old,
				}),
				i === 200 ? "running" : "finished",
			);
		const first = await page(f.db);
		expect(first).toMatchObject({
			status: "continue",
			locationComplete: false,
			scanned: 200,
			locked: 200,
			unlocked: 0,
		});
		const second = await page(f.db, first.cursor!);
		expect(second).toMatchObject({
			locationComplete: true,
			scanned: 201,
			locked: 200,
			unlocked: 1,
			inFlightAttemptIds: ["200"],
		});
		expect(second.cursor).toMatchObject({
			location: "work_items.metadata",
			after: "",
			scanned: 0,
		});
		for (let i = 1; i < f.times.length; i++)
			expect(f.times[i]! - f.times[i - 1]!).toBeGreaterThanOrEqual(2000);
		const ledgers = info.mock.calls.map(
			([line]) => line as Record<string, unknown>,
		);
		expect(ledgers).toHaveLength(2);
		for (const ledger of ledgers)
			expect(ledger).toMatchObject({
				event: "db.request",
				rowsWritten: 0,
				maxInFlight: 1,
			});
		f.sqlite.close();
	});

	it("covers nested locations, old-only prefix lookup, observer filters, and every logs partition", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
		const f = fixture();
		const logs = fixture();
		const olderLogs = fixture();
		configureLogStore(f.db, {
			LOGS_DB: logs.facade,
			LOGS_DB_2: olderLogs.facade,
		});
		f.sqlite
			.prepare("INSERT INTO git_commit_aliases VALUES (?, ?, ?)")
			.run(old, canonical, repository);
		f.sqlite
			.prepare("INSERT INTO work_items VALUES ('observer', ?, 'accepted', 1)")
			.run(JSON.stringify({ event: { beforeSha: old } }));
		f.sqlite
			.prepare("INSERT INTO work_items VALUES ('ordinary', ?, 'accepted', 0)")
			.run(JSON.stringify({ event: { sha: old } }));
		f.sqlite.prepare("INSERT INTO kernel_requests VALUES ('kernel', ?)").run(
			JSON.stringify({
				checks: [{ baseSha: old }],
				observations: [{ observedVersion: old }],
			}),
		);
		f.sqlite
			.prepare(
				"INSERT INTO external_agent_attributions VALUES ('commit', ?, 'commit')",
			)
			.run(old);
		f.sqlite
			.prepare(
				"INSERT INTO external_agent_attributions VALUES ('execution', ?, 'mcp_execution')",
			)
			.run(old);
		logs.sqlite
			.prepare(
				"INSERT INTO external_agent_attributions VALUES ('archived', ?, 'commit')",
			)
			.run(old);
		olderLogs.sqlite
			.prepare(
				"INSERT INTO external_agent_attributions VALUES ('older', ?, 'commit')",
			)
			.run(old);
		f.sqlite
			.prepare(
				"INSERT INTO external_agent_review_evidence VALUES ('review', ?, ?)",
			)
			.run(canonical, `sha:${old}`);
		f.sqlite
			.prepare(
				"INSERT INTO learning_interaction_events VALUES ('old', ?), ('new', ?)",
			)
			.run(
				JSON.stringify({ commitShas: [old.slice(0, 7)] }),
				JSON.stringify({ commitShas: [canonical.slice(0, 7)] }),
			);
		f.sqlite
			.prepare("INSERT INTO work_interactions VALUES ('decision', ?, 'open')")
			.run(
				JSON.stringify({
					decisionDeck: { options: [{ effect: { commitSha: old } }] },
				}),
			);
		f.sqlite
			.prepare("INSERT INTO work_item_comments VALUES ('comment', ?)")
			.run(JSON.stringify({ liveCommitSha: old }));
		f.sqlite
			.prepare(
				"INSERT INTO work_interaction_card_revisions VALUES ('revision', ?)",
			)
			.run(JSON.stringify({ item: { commitSha: old } }));
		const counts = [];
		let cursor: CommitAliasCountCursor | undefined;
		do {
			const result = await page(f.db, cursor);
			counts.push(result);
			cursor = result.cursor ?? undefined;
		} while (cursor);
		expect(counts).toHaveLength(
			CommitAliasCountLocationSchema.options.length + 2,
		);
		expect(
			counts.find((c) => c.location === "work_items.metadata"),
		).toMatchObject({ unlocked: 1, openObserverWorkItemIds: ["observer"] });
		expect(
			counts.find((c) => c.location === "kernel_requests.snapshot"),
		).toMatchObject({ unlocked: 1 });
		for (const result of counts.filter(
			(c) =>
				![
					"work_attempts.metadata",
					"work_items.metadata",
					"kernel_requests.snapshot",
				].includes(c.location),
		))
			expect(result).toMatchObject({ locked: 1, unlocked: 0 });
		expect(counts.at(-1)?.status).toBe("complete");
		f.sqlite.close();
		logs.sqlite.close();
		olderLogs.sqlite.close();
	});

	it("stops at an empty seed without reading business tables", async () => {
		vi.useFakeTimers();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
		const f = fixture();
		expect(await page(f.db)).toMatchObject({
			status: "no_aliases",
			cursor: null,
		});
		expect(f.times).toHaveLength(1);
		expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
			event: "commit_alias_count.no_aliases",
			aliases: 0,
		});
		f.sqlite.close();
	});
});
