import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectDispatcherHealth,
	writeDispatcherHealthSource,
} from "./dispatcher-health";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function lane() {
	const root = mkdtempSync(join(tmpdir(), "tedix-dispatcher-health-"));
	roots.push(root);
	const directory = join(root, "dispatchers", "lane-key");
	mkdirSync(directory, { recursive: true });
	return { root, directory };
}

describe("local dispatcher health", () => {
	test("collects running state, capacity, admissions and repeated reasons", () => {
		const { root, directory } = lane();
		writeDispatcherHealthSource(
			directory,
			{
				scope: ["--workspace", "connect", "--organization", "org_tedix"],
				executor: "devin",
				max: 3,
			},
			process.pid,
			"2026-10-30T09:00:00.000Z",
		);
		writeFileSync(
			join(directory, "dispatcher.log"),
			[
				{
					at: "2026-10-30T10:00:00.000Z",
					event: "admitted",
					reason: "Attempt 123",
				},
				{
					at: "2026-10-30T10:01:00.000Z",
					event: "skipped",
					reason:
						"Session label clash for 11111111-1111-4111-8111-111111111111",
				},
				{
					at: "2026-10-30T10:02:00.000Z",
					event: "skipped",
					reason:
						"Session label clash for 22222222-2222-4222-8222-222222222222",
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		writeFileSync(
			join(directory, "33333333-3333-4333-8333-333333333333-2.json"),
			JSON.stringify({ phase: "running", pid: process.pid }),
		);

		expect(
			collectDispatcherHealth(
				{ TEDIX_CONFIG_DIR: root },
				Date.parse("2026-10-30T10:05:00.000Z"),
			),
		).toEqual([
			expect.objectContaining({
				workspace: "connect",
				organization: "org_tedix",
				executor: "devin",
				lane: "lane-key",
				running: true,
				lastAdmissionAt: "2026-10-30T10:00:00.000Z",
				slotsInUse: 1,
				slotsTotal: 3,
				topReason: {
					reason: "Session label clash for <uuid>",
					count: 2,
				},
			}),
		]);
	});

	test("reports a stopped dispatcher without stale occupied slots", () => {
		const { root, directory } = lane();
		writeDispatcherHealthSource(
			directory,
			{
				scope: ["--workspace", "connect", "--organization", "org_tedix"],
				executor: "codex",
				max: 2,
			},
			2_147_483_647,
		);
		writeFileSync(
			join(directory, "33333333-3333-4333-8333-333333333333-2.json"),
			JSON.stringify({ phase: "admitted" }),
		);
		const [report] = collectDispatcherHealth({ TEDIX_CONFIG_DIR: root });
		expect(report).toMatchObject({
			running: false,
			slotsInUse: 0,
			slotsTotal: 2,
		});
	});

	test("ignores malformed and pre-descriptor lane directories", () => {
		const { root, directory } = lane();
		writeFileSync(join(directory, "health-source.json"), "not json");
		expect(collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })).toEqual([]);
	});
});
