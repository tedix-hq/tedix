import { describe, expect, it } from "bun:test";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import {
	createPlanningSync,
	externalId,
	managedBlock,
	managedPurposeMatches,
	reasoningSources,
	reconcileFields,
	slotAt,
} from "../examples/planning-board-sync/scripts/workflow";

const pageId = "11111111111141118111111111111111";
const taskId = "22222222222242228222222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const config = {
	boardKey: "shared-planning",
	stateOutputId: "state",
	reportOutputId: "report",
	ownerTediId: "owner",
	objectiveId: "objective",
	decisionUserId: "person",
	timeZone: "Europe/Berlin",
	workingDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
	workingHours: [9, 11, 13, 15, 17],
	nightlyHour: 3,
	provider: "notion",
	projectsSource: "collection://projects",
	tasksSource: "collection://tasks",
	meetingsSource: "collection://meetings",
	maxRows: 1000,
	projectFields: {
		name: "Name",
		status: "Status",
		due: "Due",
		start: "Start",
		type: "Type",
		next: "Next",
		tasks: "Tasks",
		meetings: "Meetings",
	},
	taskFields: {
		name: "Task",
		status: "Status",
		due: "Due",
		project: "Project",
	},
	meetingFields: { name: "Meeting", date: "Date", project: "Project" },
	projectStatuses: { Planning: "active", Paused: "paused" },
	activeStatuses: ["Planning"],
	projectLinks: {},
	exportProjectIds: [],
	exportSince: "2099-01-01",
	exportTaskStatus: "Todo",
	signalWorkspaceIds: [],
	signalReaders: [],
	signalDays: 7,
	maxSignalOutputs: 5,
	osBaseUrl: "https://example.test",
};
function harness(
	options: {
		uncertain?: boolean;
		ambiguous?: boolean;
		failPageReadback?: boolean;
		badCitation?: boolean;
		signalAction?: boolean;
		deniedSignal?: "list" | "output";
		hibernate?: boolean;
	} = {},
) {
	const outputs = new Map([
		[
			"state",
			{
				currentRevision: {
					revision: 1,
					content: { kind: "sheet", columns: ["Key", "State"], rows: [] },
				},
			},
		],
		[
			"report",
			{
				currentRevision: {
					revision: 1,
					content: { kind: "document", blocks: [] },
				},
			},
		],
	]);
	const projects = [
		{
			id: projectId,
			key: "PLANNING",
			name: "Shared launch",
			status: "active",
			targetDate: null,
			metadata: {},
			description: "Launch a reusable tool.",
		},
	];
	if (options.ambiguous) projects.push({ ...projects[0], id: "other-project" });
	const pages = new Map([
		[pageId, "Human agenda stays exactly as written."],
		[taskId, "Human task notes."],
	]);
	const links: unknown[] = [];
	const interactions = new Map<
		string,
		{ id: string; version: number; state: string }
	>();
	const items: any[] = [];
	const calls = {
		creates: 0,
		notionWrites: 0,
		interactions: 0,
		notionCreates: 0,
	};
	const remote = {
		url: `https://www.notion.so/${pageId}`,
		Name: "Shared launch",
		Status: "Planning",
		Due: null,
		Tasks: JSON.stringify([`https://www.notion.so/${taskId}`]),
	};
	const tasks = [
		{
			url: `https://www.notion.so/${taskId}`,
			Task: "Read the brief",
			Status: "Todo",
			Project: JSON.stringify([remote.url]),
		},
	];
	const checkpointCache = new Map();
	const sleeps = new Set<string>();
	const step = {
		sleep: async (name: string) => {
			if (sleeps.has(name)) return;
			sleeps.add(name);
			if (options.hibernate) throw new Error("HIBERNATED");
		},
		do: async (
			name: string,
			options: { retries: { limit: number; delay?: string }; timeout: string },
			action: () => Promise<unknown>,
		) => {
			// Enforce the native provider boundary instead of accepting any fake config.
			if (
				!Number.isInteger(options.retries.limit) ||
				options.retries.limit < 1 ||
				!options.retries.delay?.trim()
			)
				throw new Error(`Invalid Cloudflare retry configuration for ${name}`);
			if (checkpointCache.has(name))
				return structuredClone(checkpointCache.get(name));
			const result = await action();
			checkpointCache.set(name, structuredClone(result));
			return structuredClone(result);
		},
	};
	const env = {
		__RUN_CONTEXT__: { runId: "run-1" },
		MCP: {
			tedix: {
				get_os_output: async ({ outputId }: any) => {
					if (outputId === "denied")
						throw new Error("FORBIDDEN: Output source access is unavailable");
					return structuredClone(outputs.get(outputId));
				},
				revise_os_output: async ({
					outputId,
					expectedRevision,
					content,
				}: any) => {
					const old = outputs.get(outputId)!;
					if (old.currentRevision.revision !== expectedRevision)
						throw new Error("CAS conflict");
					outputs.set(outputId, {
						currentRevision: {
							revision: expectedRevision + 1,
							content:
								typeof content === "string"
									? {
											kind: "document",
											blocks: [{ type: "paragraph", text: content }],
										}
									: structuredClone(content),
						},
					});
					return { output: { id: outputId } };
				},
				list_os_outputs: async () => {
					if (options.deniedSignal === "list")
						throw new Error(
							"FORBIDDEN: Workspace source access is unavailable",
						);
					return {
						items:
							options.deniedSignal === "output"
								? [
										{
											id: "denied",
											title: "Restricted signal",
											updatedAt: new Date().toISOString(),
										},
									]
								: [],
					};
				},
				create_work_interaction: async () => {
					calls.interactions++;
					const request = {
						id: `decision-${calls.interactions}`,
						version: 1,
						state: "open",
					};
					interactions.set(request.id, request);
					return { interaction: structuredClone(request) };
				},
				get_work_interaction: async ({ requestId }: any) => ({
					request: structuredClone(interactions.get(requestId)),
					effectiveState: interactions.get(requestId)?.state,
				}),
				cancel_work_interaction: async ({
					requestId,
					expectedRequestVersion,
				}: any) => {
					const request = interactions.get(requestId)!;
					if (request.version !== expectedRequestVersion)
						throw new Error("Interaction version conflict");
					request.state = "cancelled";
					request.version++;
					return structuredClone(request);
				},
			},
			tedi: {
				list_projects: async () => ({
					data: structuredClone(projects),
					pagination: { hasMore: false },
				}),
				get_project: async ({ id }: any) =>
					structuredClone(projects.find((p) => p.id === id)),
				update_project: async ({ id, ...patch }: any) => {
					Object.assign(
						projects.find((p) => p.id === id)!,
						patch,
					);
					return projects.find((p) => p.id === id);
				},
				create_project: async () => {
					throw new Error("Should link the existing project");
				},
				list_work_item_sources: async () => ({
					data: structuredClone(links),
					pagination: { hasMore: false },
				}),
				attach_work_item_source: async (input: any) => {
					let source: any = links.find(
						(s: any) =>
							s.externalId === input.externalId &&
							s.projectId === input.projectId &&
							s.workItemId === input.workItemId,
					);
					if (!source) {
						source = { id: `link-${links.length}`, ...input };
						links.push(source);
					} else Object.assign(source, input);
					return { source: structuredClone(source) };
				},
				work_items_list: async () => ({
					data: structuredClone(items),
					pagination: { hasMore: false },
				}),
				work_item_create: async (input: any) => {
					CreateWorkItemInputSchema.parse(input);
					calls.creates++;
					const item = {
						id: `work-${calls.creates}`,
						createdAt: "2100-01-01",
						version: 1,
						disposition: "proposed",
						...input,
					};
					items.push(item);
					return item;
				},
				work_item_get: async ({ id }: any) =>
					structuredClone(items.find((w) => w.id === id)),
				update_work_item: async ({
					id,
					expectedWorkItemVersion,
					...patch
				}: any) => {
					const item = items.find((w) => w.id === id);
					if (item.version !== expectedWorkItemVersion)
						throw new Error("Version conflict");
					Object.assign(item, patch, { version: item.version + 1 });
					return structuredClone(item);
				},
			},
			notion: {
				notion_create_pages: async ({ pages: created }: any) => {
					calls.notionCreates++;
					const id = "4444444444444444844444444444444" + calls.notionCreates;
					pages.set(id, created[0].content);
					return { pages: [{ id, url: `https://www.notion.so/${id}` }] };
				},
				notion_fetch: async ({ id }: any) => ({
					url: id,
					text: pages.get(id.replace("https://www.notion.so/", "")) || "Schema",
					truncated: false,
				}),
				notion_query_data_sources: async ({ data }: any) => ({
					results: data.data_source_urls[0].endsWith("projects")
						? structuredClone([remote])
						: data.data_source_urls[0].endsWith("tasks")
							? structuredClone(tasks)
							: options.signalAction
								? [
										{
											url: "https://www.notion.so/55555555555545558555555555555555",
											Meeting: "Planning meeting",
											Project: JSON.stringify([remote.url]),
										},
									]
								: [],
					has_more: false,
				}),
				notion_update_page: async ({
					page_id,
					command,
					content,
					content_updates,
				}: any) => {
					calls.notionWrites++;
					if (options.uncertain) throw new Error("Lost provider response");
					if (!options.failPageReadback)
						pages.set(
							page_id,
							command === "insert_content"
								? pages.get(page_id) + "\n" + content
								: pages
										.get(page_id)!
										.replace(
											content_updates[0].old_str,
											content_updates[0].new_str,
										),
						);
					return { success: true };
				},
			},
		},
		REASON: {
			ask: async () => ({
				text: JSON.stringify({
					purpose: "Proposed purpose: make planning dependable.",
					goals: ["Proposed goal: publish a tested tool."],
					nextStep: "Read the brief.",
					actions: options.signalAction
						? [
								{
									title: "Follow up on the planning meeting",
									url: "https://www.notion.so/55555555555545558555555555555555",
								},
							]
						: [],
					signals: options.badCitation
						? [
								{
									date: "2026-10-17",
									text: "Invented",
									url: "https://unread.test",
								},
							]
						: [],
				}),
			}),
		},
	};
	const run = (runId = "run-1", replay = false, projectPageIds?: string[]) => {
		env.__RUN_CONTEXT__.runId = runId;
		if (!replay) checkpointCache.clear();
		return createPlanningSync({
			...config,
			signalWorkspaceIds: options.deniedSignal ? ["restricted-workspace"] : [],
		}).run(
			{
				payload: {
					manual: true,
					...(projectPageIds ? { projectPageIds } : {}),
				},
			},
			step,
			env,
		);
	};
	return {
		run,
		outputs,
		projects,
		pages,
		links,
		interactions,
		calls,
		remote,
		tasks,
		items,
		env,
		sleeps,
	};
}

describe("planning board synchronization", () => {
	it("keeps current meetings and signals despite oversized older notes", () => {
		const sources = reasoningSources(
			[{ url: "https://example.test/project", text: "Human planning context" }],
			[
				{
					url: "https://example.test/old",
					date: "2026-01-01",
					text: "Older transcript ".repeat(5000),
				},
				{
					url: "https://example.test/current",
					date: "2026-10-16",
					text: "Current project decision",
				},
			],
			[
				{
					url: "https://example.test/signal",
					at: "2026-10-17T10:00:00Z",
					data: { summary: "Latest signal" },
				},
			],
		);
		expect(sources.map((s) => s.url)).toEqual([
			"https://example.test/project",
			"https://example.test/signal",
			"https://example.test/current",
			"https://example.test/old",
		]);
		expect(JSON.stringify(sources)).toContain("Current project decision");
		expect(JSON.stringify(sources)).toContain("Latest signal");
		expect(JSON.stringify(sources).length).toBeLessThanOrEqual(42000);
		expect(sources.every((s) => s.text.length <= 3000)).toBe(true);
	});
	it("bounds a complete JSON packet while retaining the newest source URLs", () => {
		const evidence = Array.from({ length: 30 }, (_, index) => ({
			url: `https://example.test/meeting/${index}`,
			date: `2026-10-${String(index + 1).padStart(2, "0")}`,
			text: "Meeting notes\n".repeat(1000),
		}));
		const packet = JSON.stringify(reasoningSources([], evidence, []));
		const sources = JSON.parse(packet);
		expect(packet.length).toBeLessThanOrEqual(42000);
		expect(sources[0].url).toBe("https://example.test/meeting/29");
		expect(sources.length).toBeLessThan(30);
		expect(
			sources.every((s: { url: string }) =>
				evidence.some((e) => e.url === s.url),
			),
		).toBe(true);
	});
	it("normalizes provider page identities", () => {
		expect(externalId(`https://www.notion.so/${pageId}?x=1`)).toBe(pageId);
		expect(externalId("11111111-1111-4111-8111-111111111111")).toBe(pageId);
	});
	it("keeps Berlin working slots across summer and winter", () => {
		expect(slotAt(new Date("2026-07-06T07:23:00Z"), config)).toBe(
			"incremental",
		);
		expect(slotAt(new Date("2026-12-07T08:23:00Z"), config)).toBe(
			"incremental",
		);
		expect(slotAt(new Date("2026-07-05T07:23:00Z"), config)).toBeNull();
		expect(slotAt(new Date("2026-07-05T01:23:00Z"), config)).toBe("full");
	});
	it("detects two changed copies while preserving human ownership", () => {
		expect(
			reconcileFields(
				{ remote: { name: "old" }, local: { name: "old" } },
				{ name: "Notion" },
				{ name: "OS" },
			).conflicts,
		).toHaveLength(1);
		expect(
			reconcileFields(
				{ remote: { name: "old" }, local: { name: "old" } },
				{ name: "Notion" },
				{ name: "old" },
			).patch,
		).toEqual({ name: "Notion" });
	});
	it("rejects broken and duplicate managed markers", () => {
		expect(() =>
			managedBlock("TEDIX SYNC BEGIN board\nhuman text", "board"),
		).toThrow();
		expect(() =>
			managedBlock(
				"TEDIX SYNC BEGIN board\nTEDIX SYNC BEGIN board\nTEDIX SYNC END board",
				"board",
			),
		).toThrow();
	});
	it("links existing projects, creates each task once and preserves human text on repeated runs", async () => {
		const h = harness();
		const first = await h.run();
		expect(first.status).toBe("synced");
		expect(first.changed).toHaveLength(2);
		expect(h.pages.get(taskId)).toContain(
			"Human task notes.\nTEDIX SYNC BEGIN",
		);
		expect(h.pages.get(taskId)).toContain("/work/items/work-1");
		expect(h.calls.creates).toBe(1);
		expect(
			h.pages
				.get(pageId)
				?.startsWith("Human agenda stays exactly as written.\n"),
		).toBe(true);
		const second = await h.run("run-2");
		expect(second.status).toBe("synced");
		expect(h.calls.creates).toBe(1);
		expect(h.calls.notionWrites).toBe(2);
		expect(h.projects).toHaveLength(1);
	});
	it("restores journaled writes across durable hibernation without duplicating them", async () => {
		const h = harness({ hibernate: true });
		let result;
		let interruptions = 0;
		for (let resume = 0; resume < 6 && !result; resume++) {
			try {
				result = await h.run("same-run", resume > 0);
			} catch (error) {
				expect(String(error)).toContain("HIBERNATED");
				interruptions++;
			}
		}
		expect(interruptions).toBe(2);
		expect(result?.status).toBe("synced");
		expect(h.calls.creates).toBe(1);
		expect(h.calls.notionWrites).toBe(2);
		expect(h.sleeps.has("batch-report")).toBe(true);
	});
	it.each(["list", "output"] as const)(
		"reports denied %s signals while completing authorized board enrichment",
		async (deniedSignal) => {
			const h = harness({ deniedSignal });
			const result = await h.run();
			expect(result.status).toBe("partial");
			expect(result.changed).toHaveLength(2);
			expect(result.gaps.join(" ")).toContain(
				"Signal workspace restricted-workspace: Error: FORBIDDEN",
			);
			expect(h.pages.get(pageId)).toContain("TEDIX SYNC BEGIN");
			expect(JSON.stringify(h.outputs.get("report"))).toContain("FORBIDDEN");
		},
	);
	it("does not duplicate a task already linked under a different project", async () => {
		const h = harness();
		h.links.push({
			workItemId: "elsewhere",
			externalId: taskId,
			provider: "notion",
		});
		const result = await h.run();
		expect(result.status).toBe("partial");
		expect(h.calls.creates).toBe(0);
	});
	it("proposes and exports a cited meeting task once across repeated passes", async () => {
		const h = harness({ signalAction: true });
		expect((await h.run()).status).toBe("synced");
		expect(h.items).toHaveLength(2);
		expect(h.items[1].disposition).toBe("proposed");
		expect(h.items[1].description).toContain(
			"55555555555545558555555555555555",
		);
		expect(h.calls.notionCreates).toBe(1);
		await h.run("run-2");
		expect(h.items).toHaveLength(2);
		expect(h.calls.notionCreates).toBe(1);
	});
	it("restores state and receipts when durable steps replay without executing callbacks", async () => {
		const h = harness();
		const first = await h.run();
		const writes = h.calls.notionWrites;
		const replay = await h.run("run-1", true);
		expect(replay).toEqual(first);
		expect(h.calls.notionWrites).toBe(writes);
	});
	it("blocks uncertain provider effects across fresh runs", async () => {
		const h = harness({ uncertain: true });
		expect((await h.run()).status).toBe("partial");
		expect((await h.run("run-2")).status).toBe("partial");
		expect(h.calls.notionWrites).toBe(2);
	});
	it("never reports an unconfirmed provider write as synced", async () => {
		const h = harness({ failPageReadback: true });
		const result = await h.run();
		expect(result.status).toBe("partial");
		expect(result.changed).toEqual([]);
	});
	it("does not create or modify ambiguous projects", async () => {
		const h = harness({ ambiguous: true });
		const result = await h.run();
		expect(result.status).toBe("partial");
		expect(h.calls.creates).toBe(0);
		expect(h.calls.notionWrites).toBe(0);
	});
	it("rejects unsupported optional actions without losing valid enrichment", async () => {
		const h = harness();
		const reason = h.env.REASON.ask;
		h.env.REASON.ask = async () => {
			const result = await reason();
			const value = JSON.parse(result.text);
			value.actions = [
				{
					title: "An unsupported proposal",
					url: `${config.osBaseUrl}/work/projects/${projectId}`,
				},
			];
			return { text: JSON.stringify(value) };
		};
		const result = await h.run();
		expect(result.status).toBe("synced");
		expect(result.changed).toContain(h.remote.url);
		expect(result.rejectedActions).toEqual([{ page: h.remote.url, count: 1 }]);
		expect(h.items).toHaveLength(1);
		expect(
			h.items.some((item) => item.title === "An unsupported proposal"),
		).toBe(false);
		expect(h.pages.get(pageId)).toContain("## Purpose");
		const writes = h.calls.notionWrites;
		const replay = await h.run("run-1", true);
		expect(replay.rejectedActions).toEqual(result.rejectedActions);
		expect(h.calls.notionWrites).toBe(writes);
	});
	it("limits a selected-project retry and excludes unrelated board exports", async () => {
		const h = harness();
		const otherPageId = "66666666666646668666666666666666";
		const otherPage = {
			...h.remote,
			url: `https://www.notion.so/${otherPageId}`,
			Name: "Other launch",
			Tasks: "[]",
		};
		h.pages.set(otherPageId, "Other human agenda");
		h.projects.push({
			...h.projects[0],
			id: "77777777-7777-4777-8777-777777777777",
			key: "OTHER",
			name: "Other launch",
			metadata: { planningBoards: [config.boardKey] },
		});
		const query = h.env.MCP.notion.notion_query_data_sources;
		h.env.MCP.notion.notion_query_data_sources = async (input) =>
			input.data.data_source_urls[0].endsWith("projects")
				? { results: [h.remote, otherPage], has_more: false }
				: query(input);
		const result = await h.run("selected-retry", false, [pageId]);
		expect(result.projects).toBe(1);
		expect(result.changed).toEqual([
			`https://www.notion.so/${taskId}`,
			h.remote.url,
		]);
		expect(result.scope).toEqual([pageId]);
		expect(h.pages.get(otherPageId)).toBe("Other human agenda");
		expect(h.calls.notionCreates).toBe(0);
	});
	it("rejects empty or invalid retry selections before writing", async () => {
		for (const ids of [[], ["invalid"]]) {
			const h = harness();
			await expect(h.run("invalid-retry", false, ids)).rejects.toThrow(
				"Project selection",
			);
			expect(h.calls.notionWrites).toBe(0);
			expect(h.calls.creates).toBe(0);
		}
	});
	it("reports missing selected projects without exporting other work", async () => {
		const h = harness();
		const result = await h.run("missing-project", false, [
			"99999999999949998999999999999999",
		]);
		expect(result.status).toBe("partial");
		expect(result.projects).toBe(0);
		expect(h.calls.notionWrites).toBe(0);
		expect(h.calls.notionCreates).toBe(0);
		expect(h.calls.creates).toBe(0);
	});
	it("confirms enrichment when Notion auto-links a domain in its purpose", async () => {
		const h = harness();
		const reason = h.env.REASON.ask;
		h.env.REASON.ask = async () => {
			const result = await reason();
			const value = JSON.parse(result.text);
			value.purpose = "Example.test supports the launch.";
			return { text: JSON.stringify(value) };
		};
		const fetch = h.env.MCP.notion.notion_fetch;
		h.env.MCP.notion.notion_fetch = async (input) => {
			const page = await fetch(input);
			return {
				...page,
				text: page.text.replaceAll(
					"Example.test",
					"[Example.test](http://Example.test)",
				),
			};
		};
		const result = await h.run();
		expect(result.status).toBe("synced");
		expect(result.changed).toContain(h.remote.url);
		expect(
			h.outputs
				.get("state")!
				.currentRevision.content.rows.some(
					([key, value]) =>
						key === `effect:enrich:${pageId}` &&
						JSON.parse(value).phase === "intent",
				),
		).toBe(false);
	});
	it("requires the exact managed purpose despite provider link formatting", () => {
		const page = `Human agenda\nTEDIX SYNC BEGIN shared-planning\n## Purpose\n[Example.test](http://Example.test) supports the launch.\n## Goals\n- Ship it\nTEDIX SYNC END shared-planning`;
		expect(
			managedPurposeMatches(
				page,
				"shared-planning",
				"Example.test supports the launch.",
			),
		).toBe(true);
		expect(
			managedPurposeMatches(
				page,
				"shared-planning",
				"Example.test supports the launch",
			),
		).toBe(false);
		expect(
			managedPurposeMatches(
				page,
				"other-board",
				"Example.test supports the launch.",
			),
		).toBe(false);
		expect(
			managedPurposeMatches(
				page.replace("## Purpose", "## Other"),
				"shared-planning",
				"Example.test supports the launch.",
			),
		).toBe(false);
	});
	it("rejects invented citations before writing project enrichment", async () => {
		const h = harness({ badCitation: true });
		expect((await h.run()).status).toBe("partial");
		expect(h.pages.get(pageId)).toBe("Human agenda stays exactly as written.");
		expect(h.calls.notionWrites).toBe(1);
	});
	it("exports new OS tasks only from board projects and does not recreate them", async () => {
		const h = harness();
		h.items.push({
			id: "new-work",
			title: "A new OS task",
			createdAt: "2100-01-01",
			projectId,
			sourceIntentId: "session-task",
		});
		await h.run();
		expect(h.calls.notionCreates).toBe(1);
		await h.run("run-2");
		await h.run("run-3");
		expect(h.calls.notionCreates).toBe(1);
		expect(h.links.some((link: any) => link.workItemId === "new-work")).toBe(
			true,
		);
	});
	it.each([false, true])(
		"does not re-export a recent title-matched task even when backlink readback fails (%s)",
		async (failPageReadback) => {
			const h = harness({ failPageReadback });
			h.items.push({
				id: "existing-work",
				title: "Read the brief",
				createdAt: "2100-01-01",
				projectId,
				sourceIntentId: "session-task",
				version: 1,
				dueDate: null,
			});
			await h.run();
			expect(h.calls.creates).toBe(0);
			expect(h.calls.notionCreates).toBe(0);
		},
	);
	it("allows a new cited task when the same meeting gains new evidence", async () => {
		const h = harness({ signalAction: true });
		await h.run();
		const url = "https://www.notion.so/55555555555545558555555555555555";
		h.pages.set(
			url.split("/").pop()!,
			"New agreement: review the launch checklist.",
		);
		h.env.REASON.ask = async () => ({
			text: JSON.stringify({
				purpose: "Make planning dependable.",
				goals: [],
				nextStep: "Review the launch checklist.",
				signals: [],
				actions: [{ title: "Review the launch checklist", url }],
			}),
		});
		expect((await h.run("run-2")).status).toBe("synced");
		expect(h.items).toHaveLength(3);
		expect(h.calls.notionCreates).toBe(2);
		await h.run("run-3");
		expect(h.items).toHaveLength(3);
	});
	it("does not recreate a known Notion counterpart when it becomes unnamed", async () => {
		const h = harness();
		await h.run();
		h.remote.Name = "";
		expect((await h.run("run-2")).status).toBe("partial");
		expect(h.calls.notionCreates).toBe(0);
		expect(h.projects).toHaveLength(1);
	});
	it("exports an explicitly selected OS project without auto-merging", async () => {
		const h = harness();
		h.projects.push({
			...h.projects[0],
			id: "new-project",
			name: "New shared project",
			metadata: { planningBoards: [config.boardKey] },
		});
		const result = await h.run();
		expect(result.status).toBe("synced");
		expect(h.calls.notionCreates).toBe(1);
		expect(h.links.some((link: any) => link.projectId === "new-project")).toBe(
			true,
		);
	});
	it("refuses a second run while another lease is live", async () => {
		const h = harness();
		h.outputs
			.get("state")!
			.currentRevision.content.rows.push([
				"lock",
				JSON.stringify({ runId: "another-run", until: "2100-01-01" }),
			]);
		await expect(h.run()).rejects.toThrow("Another board sync");
		expect(h.calls.creates).toBe(0);
		expect(h.calls.notionWrites).toBe(0);
	});
	it("updates and clears human due dates without completing Work", async () => {
		const h = harness();
		await h.run();
		h.tasks[0].Due = "2026-10-20";
		await h.run("run-2");
		expect(h.items[0].dueDate).toBe("2026-10-20");
		h.tasks[0].Due = null;
		await h.run("run-3");
		expect(h.items[0].dueDate).toBeNull();
		expect(h.items[0].disposition).toBe("proposed");
	});
	it("closes resolved conflict cards and re-arms a later disagreement", async () => {
		const h = harness();
		await h.run();
		h.projects[0].name = "OS edit";
		h.remote.Name = "Notion edit";
		await h.run("run-2");
		h.projects[0].name = h.remote.Name;
		await h.run("run-3");
		expect(h.interactions.get("decision-1")?.state).toBe("cancelled");
		h.projects[0].name = "New OS edit";
		h.remote.Name = "New Notion edit";
		await h.run("run-4");
		expect(h.calls.interactions).toBe(2);
		expect(h.interactions.get("decision-2")?.state).toBe("open");
	});
	it("recovers a confirmed conflict card when its local flag was lost", async () => {
		const h = harness();
		await h.run();
		h.projects[0].name = "OS edit";
		h.remote.Name = "Notion edit";
		await h.run("run-2");
		const rows = h.outputs.get("state")!.currentRevision.content.rows;
		rows.splice(
			rows.findIndex((row) => row[0] === `conflict:${pageId}`),
			1,
		);
		await h.run("run-3");
		expect(h.calls.interactions).toBe(1);
	});
	it("deduplicates conflict cards across passes", async () => {
		const h = harness();
		await h.run();
		h.projects[0].name = "OS edit";
		h.remote.Name = "Notion edit";
		await h.run("run-2");
		await h.run("run-3");
		expect(h.calls.interactions).toBe(1);
	});
});
