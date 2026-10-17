import {
	describe,
	expect,
	test,
	mock,
	afterEach,
	setSystemTime,
} from "bun:test";
import workflow from "./workflow.js";
const AT = "2026-10-17T22:00:00.000Z";
afterEach(() => setSystemTime());
function fixture() {
	setSystemTime(new Date(AT));
	const items = new Map();
	const comments = new Map();
	const histories = new Map();
	const outputs = new Map();
	const writes = [];
	let order = [];
	let ranksTruncated = false;
	let decision = "rebrief";
	const config = {
		workspaceId: "example-workspace",
		projectIds: ["example-project"],
		maxLanes: 1,
		people: [
			{
				id: "example-person",
				timeZone: "Europe/Berlin",
				nightStart: "21:00",
				briefAt: "08:15",
				deckUrl: "https://os.example.com/deck",
			},
		],
	};
	function item(id, extra = {}) {
		const value = {
			id,
			title: id,
			version: 1,
			projectId: "example-project",
			disposition: "accepted",
			description: "Original brief",
			startAt: null,
			metadata: { executor: "codex" },
			activeAttempt: null,
			...extra,
		};
		items.set(id, value);
		comments.set(id, []);
		histories.set(id, []);
		return value;
	}
	const api = {
		list_projects: async () => ({
			data: [{ id: "labelled-project", metadata: { labels: ["night-shift"] } }],
			pagination: { hasMore: false },
		}),
		list_work_items: async ({ projectId, accountableOwnerId }) => ({
			data: [...items.values()].filter(
				(i) =>
					i.projectId === projectId &&
					i.disposition === "accepted" &&
					(!accountableOwnerId || i.accountableOwnerId === accountableOwnerId),
			),
			pagination: { hasMore: false },
		}),
		get_work_items_by_id: async ({ id }) => ({
			workItem: structuredClone(items.get(id)),
			comments: structuredClone(comments.get(id)),
			evidence: [],
		}),
		list_work_item_attempts: async ({ id }) => ({
			data: structuredClone(histories.get(id)),
			nextCursor: null,
		}),
		list_attempt_projection: async ({ projectId }) => ({
			data: projectId
				? [...histories]
						.filter(([id]) => items.get(id).projectId === projectId)
						.flatMap(([id, rows]) =>
							rows.map((attempt) => ({ workItem: { id }, attempt })),
						)
				: [],
			hasMore: false,
			nextCursor: null,
		}),
		list_ready_work: async ({ projectId }) => ({
			items: order
				.filter((id) => items.get(id)?.projectId === projectId)
				.map((id, i) => ({ workItemId: id, score: 100 - i })),
			factsTruncated: ranksTruncated,
			nextCursor: null,
		}),
		update_work_item_specification: async ({
			id,
			expectedWorkItemVersion,
			...update
		}) => {
			const value = items.get(id);
			if (value.version !== expectedWorkItemVersion)
				throw new Error("CONFLICT");
			Object.assign(value, update, { version: value.version + 1 });
			if (update.executor) value.metadata.executor = update.executor;
			writes.push({ type: "plan", id, ...update });
			return value;
		},
		add_comment: async ({ id, ...comment }) => {
			comments.get(id).push(comment);
			writes.push({ type: "comment", id, ...comment });
			return comment;
		},
		complete_work_item: async ({ id }) => {
			items.get(id).disposition = "completed";
			writes.push({ type: "complete", id });
			return { id };
		},
		list_os_outputs: async () => ({
			items: [...outputs.values()].map(({ id, title }) => ({ id, title })),
			truncated: false,
		}),
		create_os_output: async ({ title, content }) => {
			const id = "doc-" + outputs.size;
			outputs.set(id, { id, title, currentRevision: { revision: 1, content } });
			return { output: { id } };
		},
		get_os_output: async ({ outputId }) =>
			structuredClone(outputs.get(outputId)),
		revise_os_output: async ({ outputId, content, expectedRevision }) => {
			const r = outputs.get(outputId);
			expect(r.currentRevision.revision).toBe(expectedRevision);
			r.currentRevision = { revision: expectedRevision + 1, content };
			return r;
		},
	};
	const reason = mock(async ({ key }) =>
		key.startsWith("morning-")
			? {
					text: "What you can use now: Example work. Learned: preserve the existing worktree.",
					empty: false,
				}
			: {
					text: JSON.stringify({
						decision,
						reason: "Read the recorded result",
						learned: "Resume your own worktree",
					}),
					empty: false,
					modelIdentity: { provider: "example", model: "small" },
				},
	);
	const step = { do: async (_name, ...args) => args.at(-1)() };
	const nudge = mock(async () => ({ pending: true }));
	const run = (overrides = {}) =>
		workflow.run({ payload: { ...config, ...overrides } }, step, {
			MCP: { tedix: api, tedi: { run_tedi_turn: nudge } },
			REASON: { ask: reason },
			__RUN_CONTEXT__: { runId: "example-run" },
		});
	return {
		nudge,
		items,
		comments,
		histories,
		outputs,
		writes,
		api,
		item,
		run,
		reason,
		setOrder: (v) => (order = v),
		setDecision: (v) => (decision = v),
		setTruncated: (v) => (ranksTruncated = v),
	};
}
describe("native night coordination", () => {
	test("selects scheduler-ranked Work and holds the remainder across labelled projects", async () => {
		const f = fixture();
		f.item("low");
		f.item("high");
		f.item("labelled", {
			projectId: "labelled-project",
			metadata: { executor: "claude-code" },
		});
		f.setOrder(["high", "labelled", "low"]);
		const r = await f.run();
		expect(r.selected).toEqual(["high"]);
		expect(f.items.get("low").startAt).not.toBeNull();
		expect(f.items.get("labelled").startAt).not.toBeNull();
		expect([...f.outputs.values()][0].title).toBe("Night log 2026-10-18");
		expect(f.reason).not.toHaveBeenCalled();
	});
	test("rebriefs an expired lane once, retaining original brief and a fresh version", async () => {
		const f = fixture();
		f.item("dead");
		f.setOrder(["dead"]);
		f.histories.set("dead", [
			{
				id: "old-attempt",
				outcome: "expired",
				summary: null,
				metadata: { lane: true },
			},
		]);
		await f.run();
		expect(f.items.get("dead").description).toContain(
			"Resume after Attempt old-attempt",
		);
		expect(f.items.get("dead").description).toContain("Original brief");
		expect(f.items.get("dead").version).toBe(2);
		expect(
			f.comments.get("dead")[0].metadata.nightReview.modelIdentity.model,
		).toBe("small");
		await f.run();
		expect(f.reason).toHaveBeenCalledTimes(1);
		expect(f.items.get("dead").version).toBe(2);
	});
	test("leaves a live peer Attempt untouched and subtracts its capacity", async () => {
		const f = fixture();
		f.item("peer", { activeAttempt: { attemptId: "live" } });
		f.item("waiting");
		f.setOrder(["waiting"]);
		const r = await f.run();
		expect(r.selected).toEqual([]);
		expect(f.writes.some((w) => w.id === "peer")).toBe(false);
	});
	test("escalations cannot be released by ranking or the next cycle", async () => {
		const f = fixture();
		f.item("human");
		f.setOrder(["human"]);
		f.setDecision("escalate");
		f.histories.set("human", [
			{ id: "stopped", outcome: "failed", metadata: { lane: true } },
		]);
		expect((await f.run()).selected).toEqual([]);
		expect((await f.run()).selected).toEqual([]);
		expect(f.reason).toHaveBeenCalledTimes(1);
	});
	test("accepts only succeeded settlements and then completes canonical Work", async () => {
		const f = fixture();
		f.item("done");
		f.histories.set("done", [
			{ id: "settled", outcome: "succeeded", metadata: { lane: true } },
		]);
		f.setDecision("accept");
		await f.run();
		expect(f.items.get("done").disposition).toBe("completed");
		f.item("failed");
		f.histories.set("failed", [
			{ id: "bad", outcome: "failed", metadata: { lane: true } },
		]);
		await expect(f.run()).rejects.toThrow("Cannot accept unsuccessful lane");
	});
	test("checks for a new live Attempt immediately before applying a cached review", async () => {
		const f = fixture();
		f.item("race");
		f.histories.set("race", [
			{ id: "old", outcome: "expired", metadata: { lane: true } },
		]);
		f.api.list_attempt_projection = async () => ({
			data: [
				{
					workItem: { id: "race" },
					attempt: { outcome: null, expiresAt: "2026-10-17T22:05:00.000Z" },
				},
			],
		});
		await expect(f.run()).rejects.toThrow("new Attempt");
		expect(f.writes).toHaveLength(0);
	});
	test("never dispatches from truncated ranking", async () => {
		const f = fixture();
		f.item("one");
		f.setOrder(["one"]);
		f.setTruncated(true);
		await expect(f.run()).rejects.toThrow("incomplete");
		expect(f.writes).toHaveLength(0);
	});
	test("writes the person's 08:15 Berlin brief with their Deck and learned lessons", async () => {
		const f = fixture();
		setSystemTime(new Date("2026-10-18T06:15:00.000Z"));
		const r = await f.run();
		expect(r.briefs).toHaveLength(1);
		const b = [...f.outputs.values()].find(
			(d) => d.title === "Morning brief 2026-10-18",
		);
		expect(JSON.stringify(b)).toContain("https://os.example.com/deck");
		expect(JSON.stringify(b)).toContain("Learned");
	});
	test("DST keeps the Berlin morning brief at 08:15", async () => {
		const f = fixture();
		setSystemTime(new Date("2026-10-25T07:15:00.000Z"));
		expect((await f.run({ probe: true })).slots[0].brief).toBe(true);
	});
	test("reviews a legacy lane without granting a code executor or overriding human assignment", async () => {
		const f = fixture();
		f.item("legacy", { metadata: { agentHarness: "codex" } });
		f.item("human", { metadata: { executor: "human", agentHarness: "codex" } });
		f.histories.set("legacy", [
			{
				id: "lost",
				outcome: "expired",
				externalSessionKey: "codex:example",
				metadata: { lane: true },
			},
		]);
		f.setOrder(["legacy", "human"]);
		expect((await f.run()).selected).toEqual([]);
		expect(f.items.get("legacy").description).toContain(
			"Resume after Attempt lost",
		);
		expect(f.items.get("legacy").metadata.executor).toBeUndefined();
		expect(f.items.get("human").metadata.executor).toBe("human");
	});
	test("nudges only accepted owned Work without a live Attempt", async () => {
		const f = fixture();
		const config = {
			tediTurns: [{ namespace: "tedi", ownerId: "example-tedi" }],
		};
		await f.run(config);
		expect(f.nudge).not.toHaveBeenCalled();
		f.item("owned", {
			accountableOwnerId: "example-tedi",
			metadata: { executor: "tedi" },
		});
		await f.run(config);
		expect(f.nudge).toHaveBeenCalledTimes(1);
		f.items.get("owned").activeAttempt = { attemptId: "running" };
		await f.run(config);
		expect(f.nudge).toHaveBeenCalledTimes(1);
	});
	test("does not spend lane capacity on an ordinary external Work Attempt", async () => {
		const f = fixture();
		f.item("session", {
			metadata: { agentHarness: "codex" },
			activeAttempt: { attemptId: "ordinary" },
		});
		f.item("lane");
		f.setOrder(["lane"]);
		expect((await f.run()).selected).toEqual(["lane"]);
	});
	test("holds Work whose coordinator lacks stewardship without changing ownership", async () => {
		const f = fixture();
		f.item("peer");
		f.setOrder(["peer"]);
		expect((await f.run({ coordinatorId: "example-tedi" })).selected).toEqual(
			[],
		);
		expect(f.writes).toHaveLength(0);
	});
	test("ordinary accepted Work and superseded lane Attempts do not pollute the night log", async () => {
		const f = fixture();
		f.item("ordinary", { metadata: { agentHarness: "codex" } });
		f.histories.set("ordinary", [
			{ attemptNumber: 2, metadata: {} },
			{ attemptNumber: 1, metadata: { lane: true } },
		]);
		await f.run({ coordinatorId: "example-tedi" });
		expect(JSON.stringify([...f.outputs.values()])).not.toContain("ordinary");
		expect(f.reason).not.toHaveBeenCalled();
	});
	test("refuses truncated lane recovery projections before dispatch", async () => {
		const f = fixture();
		f.api.list_attempt_projection = async () => ({
			data: [],
			hasMore: true,
			nextCursor: null,
		});
		await expect(f.run()).rejects.toThrow("cannot advance");
		expect(f.writes).toHaveLength(0);
	});
	test("off-slot and probes make no model calls or writes", async () => {
		const f = fixture();
		setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		expect(await f.run()).toEqual({ status: "off_slot" });
		await f.run({ probe: true });
		expect(f.writes).toHaveLength(0);
		expect(f.outputs.size).toBe(0);
		expect(f.reason).not.toHaveBeenCalled();
	});
});
