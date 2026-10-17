import { describe, expect, it } from "bun:test";
import board from "../examples/living-status-board/scripts/workflow";

function fixture(
	options: { grant?: boolean; omitGoal?: boolean; badProse?: boolean } = {},
) {
	const saved: unknown[] = [];
	const reads: unknown[] = [];
	const now = new Date().toISOString();
	let content: unknown;
	const payload = {
		outputId: "board",
		workspaceId: "private",
		ownerUserId: "ada",
		baseUrl: "https://workspace.example",
		timeZone: "Europe/Berlin",
	};
	const env = {
		__RUN_CONTEXT__: { skillId: "board-skill" },
		MCP: {
			tedix: {
				list_agent_session_activity: async (args) => {
					reads.push(args.requests);
					return options.grant === false
						? { status: "needs_grant" }
						: {
								status: "ready",
								requests:
									args.requests.statuses[0] === "done"
										? [
												{
													status: "done",
													sourceAt: "2020-01-01T00:00:00Z",
													statusChangedAt: now,
													text: "Ship dashboard",
													evidence: "https://proof.example/result",
												},
											]
										: args.requests.statuses[0] === "waiting_on_user"
											? [
													{
														status: "waiting_on_user",
														text: "Review the draft",
														evidence: "Draft is ready",
													},
												]
											: [],
							};
				},
				list_tedi_objectives: async () => ({
					data: [{ id: "goal", title: "Reliable dashboard" }],
					pagination: { hasMore: false },
				}),
				list_activity: async () => ({ events: [] }),
				run_workflow_history: async () => ({ runs: [] }),
				list_work_interactions: async () => ({ data: [], hasMore: false }),
				get_os_output: async () => ({
					output: { workspaceId: "private", kind: "document" },
					currentRevision: {
						revision: content ? 2 : 1,
						content: { richText: content },
					},
				}),
				revise_os_output: async (args) => {
					saved.push(args);
					content = args.content.richText;
				},
			},
		},
		REASON: {
			ask: async () => ({
				text: JSON.stringify({
					now: [],
					done: [
						{
							index: 0,
							text: options.badProse
								? "Internal deadbeef"
								: "Dashboard shipped",
						},
					],
					needs: [{ index: 0, text: "Open the draft and reply with edits." }],
					goals: options.omitGoal
						? []
						: [{ index: 0, name: "Reliability", status: "No recent evidence" }],
				}),
			}),
		},
	};
	const step = { do: async (_name, _options, action) => action() };
	return { run: () => board.run({ payload }, step, env), saved, reads };
}

describe("living status board", () => {
	it("retains the board when owner consent is absent", async () => {
		const f = fixture({ grant: false });
		expect(await f.run()).toMatchObject({ status: "waiting_for_grant" });
		expect(f.saved).toHaveLength(0);
	});
	it("renders native tables and checklists with proof links, including old requests closed today", async () => {
		const f = fixture();
		expect(await f.run()).toMatchObject({
			status: "updated",
			revision: 2,
			goals: 1,
		});
		const write = f.saved[0] as {
			content: {
				richText: { content: Array<{ type: string; content?: unknown }> };
			};
		};
		expect(
			write.content.richText.content.filter((x) => x.type === "table"),
		).toHaveLength(2);
		expect(
			write.content.richText.content.some((x) => x.type === "taskList"),
		).toBe(true);
		expect(JSON.stringify(write)).toContain("https://proof.example/result");
		expect(f.reads[2]).toHaveProperty("changedSince");
	});
	it("does not save summaries that omit an active goal", async () => {
		const f = fixture({ omitGoal: true });
		await expect(f.run()).rejects.toThrow("goal was omitted");
		expect(f.saved).toHaveLength(0);
	});
	it("rejects internal identifiers in visible prose", async () => {
		const f = fixture({ badProse: true });
		await expect(f.run()).rejects.toThrow("prose constraints");
		expect(f.saved).toHaveLength(0);
	});
});
