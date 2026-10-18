import { describe, expect, test, setSystemTime, afterEach } from "bun:test";
import {
	parseCapabilityManifest,
	isMethodAllowed,
} from "../../packages/api-contract/src/utils/skill-manifest.ts";
import workflow, {
	localClock,
	localDayBounds,
	projectRow,
} from "./workflow.js";
const NOW = new Date("2026-10-18T08:45:00.000Z");
const config = {
	outputId: "saved",
	personId: "person",
	timeZone: "Europe/Berlin",
	manual: true,
};
const project = {
	id: "project",
	name: "Website",
	description: "Make the website useful. More details.",
	createdAt: "2026-10-01T00:00:00.000Z",
};
const totals = {
	needsYou: 0,
	decisions: 0,
	documents: 0,
	lastTouched: null,
	receipts: [],
};
afterEach(() => setSystemTime());

describe("Today editions", () => {
	test("uses Berlin calendar days and keeps both seasonal clock-change days whole", () => {
		expect(
			localClock(new Date("2026-10-17T23:00:00.000Z"), "Europe/Berlin").day,
		).toBe("2026-10-18");
		for (const [day, hours] of [
			["2026-03-29", 23],
			["2026-10-25", 25],
		]) {
			const bounds = localDayBounds(day, "Europe/Berlin");
			expect(
				(Date.parse(bounds.until) - Date.parse(bounds.since)) / 3600000,
			).toBe(hours);
		}
	});
	test("deduplicates completed Work and commits, ignores yesterday, and never calls a commit shipped", () => {
		const event = {
			id: "receipt",
			workItemId: "work",
			eventType: "work.completed",
			createdAt: NOW.toISOString(),
			settlement: { commitSha: "abc" },
		};
		const row = projectRow(
			project,
			[
				event,
				event,
				{ ...event, workItemId: "old", createdAt: "2026-10-17T08:00:00.000Z" },
			],
			[],
			totals,
			NOW,
			config,
		);
		expect(row.row[1]).toBe("Make the website useful.");
		expect(row.row[2]).toBe("1 task finished, 1 commit recorded.");
		expect(row.row[5]).toBe("/work/projects/project");
		expect(row.row[6]).toContain("project=project&day=2026-10-18");
		expect(row.row[2]).not.toContain("shipped");
	});
	test("shows a named live executor and omits an expired lease", () => {
		const attempt = {
			outcome: null,
			runtimeState: "running",
			executorType: "external_agent",
			expiresAt: "2026-10-18T09:00:00.000Z",
			startedAt: NOW.toISOString(),
			metadata: { agentHarness: "claude-code" },
		};
		const row = projectRow(
			project,
			[],
			[{ attempt, workItem: { title: "Improve the page" } }],
			totals,
			NOW,
			config,
		);
		expect(row.row[3]).toContain("Improve the page (Claude Code)");
		expect(
			projectRow(
				project,
				[],
				[
					{
						attempt: { ...attempt, expiresAt: "2026-10-18T07:00:00.000Z" },
						workItem: { title: "Old" },
					},
				],
				totals,
				NOW,
				config,
			).row[3],
		).toBe("Nothing running now.");
	});
	test("preserves the saved edition when an activity page is truncated without a cursor", async () => {
		setSystemTime(NOW);
		let writes = 0;
		const api = {
			list_tedis: async () => ({ data: [], pagination: { hasMore: false } }),
			get_active_purpose_charter: async () => ({
				charter: { purpose: "Help the team." },
			}),
			list_projects: async () => ({
				data: [project],
				pagination: { hasMore: false },
			}),
			list_activity: async () => ({ events: [], truncated: true }),
			revise_os_output: async () => {
				writes++;
			},
		};
		await expect(
			workflow.run(
				{ payload: config },
				{ do: async (_name, fn) => fn() },
				{ MCP: { tedix: api } },
			),
		).rejects.toThrow("truncated");
		expect(writes).toBe(0);
	});
	test("paginates project activity and saves one edition, collapsing quiet projects and excluding old ones", async () => {
		setSystemTime(NOW);
		let content;
		let pages = 0;
		const event = {
			id: "receipt",
			workItemId: "work",
			eventType: "work.completed",
			createdAt: NOW.toISOString(),
			settlement: null,
		};
		const api = {
			list_tedis: async () => ({ data: [], pagination: { hasMore: false } }),
			get_active_purpose_charter: async () => ({
				charter: { purpose: "Help the team." },
			}),
			list_projects: async () => ({
				data: [
					project,
					{ ...project, id: "quiet", updatedAt: NOW.toISOString() },
					{ ...project, id: "old" },
				],
				pagination: { hasMore: false },
			}),
			list_activity: async ({ projectId, cursor }) =>
				projectId === "project"
					? (pages++,
						cursor
							? { events: [event], nextCursor: null }
							: {
									events: [],
									nextCursor: { at: NOW.toISOString(), id: "next" },
								})
					: { events: [], nextCursor: null },
			list_attempt_projection: async () => ({ data: [], nextCursor: null }),
			get_today_project_totals: async () => totals,
			get_os_output: async () => ({ currentRevision: { revision: 4 } }),
			revise_os_output: async (input) => {
				expect(input.expectedRevision).toBe(4);
				content = input.content;
				return {};
			},
		};
		const manifest = parseCapabilityManifest(
			await Bun.file(new URL("./SKILL.md", import.meta.url)).text(),
		);
		const permitted = new Proxy(api, {
			get(target, method) {
				if (!isMethodAllowed(manifest, "tedix", String(method)))
					throw new Error(`Undeclared tool: ${String(method)}`);
				return target[method];
			},
		});
		const result = await workflow.run(
			{ payload: config },
			{ do: async (_name, fn) => fn() },
			{ MCP: { tedix: permitted } },
		);
		expect(pages).toBe(2);
		expect(result.projects).toBe(2);
		expect(content.blocks[3].text).toBe("1 project quiet");
		expect(content.blocks[4].rows).toHaveLength(1);
	});
	test("does no source reads outside local edition slots", async () => {
		setSystemTime(new Date("2026-10-18T09:15:00.000Z"));
		expect(
			await workflow.run(
				{ payload: { ...config, manual: false } },
				{ do: async (_name, fn) => fn() },
				{ MCP: { tedix: {} } },
			),
		).toEqual({ status: "off_slot" });
	});
});
