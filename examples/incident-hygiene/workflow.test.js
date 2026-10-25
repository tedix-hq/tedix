import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import workflow from "./workflow.js";

const manifest = Bun.YAML.parse(
	readFileSync(new URL("./SKILL.md", import.meta.url), "utf8").split("---")[1],
);
const NOW = new Date("2026-10-25T12:00:00Z");
afterEach(() => setSystemTime());
function fixture(title = "Investigate ship deploy:api failure") {
	setSystemTime(NOW);
	const c = {
		...manifest.capabilities.schedule.params,
		internalProjectIds: ["internal"],
		osOrigin: "https://os.example.test",
		ship: {
			owner: "example",
			repo: "ops",
			workflow: "ship.yml",
			branch: "main",
			successTitle: "Ship latest main",
		},
	};
	const item = {
		id: "old",
		title,
		description: "",
		disposition: "accepted",
		projectId: "internal",
		version: 1,
		createdAt: "2026-10-20T00:00:00Z",
		metadata: { lastRunId: "failed", skillId: "skill" },
	};
	const detail = { workItem: item, comments: [] };
	const attempts = { data: [], nextCursor: null };
	const runs = [
		{
			id: "failed",
			skillId: "skill",
			tediId: "owner",
			status: "failed",
			completedAt: "2026-10-20T01:00:00Z",
		},
		{
			id: "success",
			skillId: "skill",
			tediId: "owner",
			status: "completed",
			hasError: false,
			startedAt: "2026-10-21T01:00:00Z",
			completedAt: "2026-10-21T02:00:00Z",
		},
	];
	const ship = {
		id: 1,
		display_title: "Ship latest main",
		status: "completed",
		conclusion: "success",
		created_at: "2026-10-21T00:00:00Z",
		html_url: "https://github.example.test/run/1",
	};
	const tedi = {
		work_items_list: mock(async ({ disposition }) => ({
			data: disposition === item.disposition ? [item] : [],
			pagination: { hasMore: false },
		})),
		work_item_get: mock(async () => detail),
		list_work_attempts: mock(async () => attempts),
		list_skill_workflow_history: mock(async () => ({ runs })),
		cancel_work_item: mock(async () => {
			item.disposition = "cancelled";
			return item;
		}),
		work_item_comment: mock(async () => ({ id: "receipt" })),
	};
	const home = {
		runStatus: "failed",
		kernelRoute: { routeKind: "answer_in_home" },
	};
	const env = {
		__RUN_CONTEXT__: { runId: "hygiene" },
		MCP: {
			tedi,
			home: { read_home_run: mock(async () => home) },
			github: {
				list_actions_resources: mock(async () => ({ workflow_runs: [ship] })),
			},
		},
	};
	return {
		c,
		item,
		detail,
		attempts,
		runs,
		ship,
		tedi,
		home,
		env,
		run: () =>
			workflow.run({ payload: c }, { do: async (_key, fn) => fn() }, env),
	};
}

for (const title of [
	"Investigate ship deploy:api failure",
	"Red Ship all: failed",
	"Commit watch: failed",
	"Factory incident: example",
	"Skill run failed: example",
]) {
	test(`closes recovered ${title} with its run citation`, async () => {
		const f = fixture(title);
		f.c.dryRun = false;
		const result = await f.run();
		expect(result.closed).toHaveLength(1);
		expect(f.tedi.cancel_work_item.mock.calls[0][0].reason).toContain(
			title.startsWith("Factory") || title.startsWith("Skill")
				? "/activity/runs/success"
				: f.ship.html_url,
		);
	});
}
for (const text of [
	"Filed automatically: generated request",
	"Diagnose the run failure",
]) {
	test(`closes idle stub: ${text}`, async () => {
		const f = fixture("Automatic stub");
		f.item.description = text;
		f.c.dryRun = false;
		expect((await f.run()).closed[0].reason).toContain("no Attempt");
	});
}
test("closes only a verified failed one-off Home question", async () => {
	const f = fixture("What failed?");
	f.c.dryRun = false;
	f.item.sourceSessionKey = "home:example";
	f.item.metadata.homeRunId = "home-run";
	expect((await f.run()).closed[0].evidence).toEndWith(
		"/activity/runs/home-run",
	);
});
test("dry run lists closure reasons and evidence without writes or reconciliation", async () => {
	const f = fixture("Skill run failed: example");
	const result = await f.run();
	expect(result.wouldClose).toHaveLength(1);
	expect(result.closed).toEqual([]);
	expect(f.tedi.cancel_work_item).not.toHaveBeenCalled();
	expect(f.tedi.work_item_comment).not.toHaveBeenCalled();
	expect(
		f.tedi.list_skill_workflow_history.mock.calls.every(
			([input]) => input.reconcile === false,
		),
	).toBe(true);
});
for (const state of ["queued", "running", "waiting", "retrying"]) {
	test(`preserves ${state} Attempt`, async () => {
		const f = fixture();
		f.c.dryRun = false;
		f.attempts.data.push({ runtimeState: state });
		expect((await f.run()).wouldClose).toEqual([]);
	});
}
for (const change of [
	(f) =>
		f.detail.comments.push({
			authorType: "user",
			createdAt: "2026-10-24T00:00:00Z",
		}),
	(f) => f.detail.comments.push({ authorType: "user", createdAt: "unknown" }),
	(f) => {
		f.item.projectId = "customer";
	},
	(f) => {
		f.item.projectId = null;
	},
	(f) => {
		f.item.createdAt = "unknown";
	},
	(f) => {
		f.item.metadata.lastFailedAt = "2026-10-25T01:00:00Z";
	},
	(f) => {
		f.item.updatedAt = "2026-10-24T12:00:00Z";
	},
	(f) => {
		f.attempts.nextCursor = "more";
	},
]) {
	test("preserves recent human activity, customer/unscoped Work and incomplete facts", async () => {
		const f = fixture();
		f.c.dryRun = false;
		change(f);
		expect((await f.run()).closed).toEqual([]);
		expect(f.tedi.cancel_work_item).not.toHaveBeenCalled();
	});
}
test("permits old human and recent machine comments", async () => {
	const f = fixture();
	f.c.dryRun = false;
	f.detail.comments.push(
		{ authorType: "user", createdAt: "2026-10-21T00:00:00Z" },
		{ authorType: "tedi", createdAt: NOW.toISOString() },
	);
	expect((await f.run()).closed).toHaveLength(1);
});
test("permits terminal Attempt for recovered incident but never for idle stubs", async () => {
	const f = fixture();
	f.attempts.data.push({ runtimeState: "failed", outcome: "failed" });
	expect((await f.run()).wouldClose).toHaveLength(1);
	f.item.title = "Stub";
	f.item.description = "Filed automatically: generated";
	expect((await f.run()).wouldClose).toEqual([]);
});
for (const change of [
	(f) => {
		f.ship.conclusion = "failure";
	},
	(f) => {
		f.ship.display_title = "Ship an old revision";
	},
	(f) => {
		f.ship.created_at = "2026-10-19T00:00:00Z";
	},
]) {
	test("requires a later successful latest-main Ship", async () => {
		const f = fixture();
		change(f);
		expect((await f.run()).wouldClose).toEqual([]);
	});
}
for (const change of [
	(f) => {
		f.runs[1].skillId = "other";
	},
	(f) => {
		f.runs[1].tediId = "other";
	},
	(f) => {
		f.runs[1].status = "failed";
	},
	(f) => {
		f.runs[1].outcome = "blocked";
	},
	(f) => {
		f.runs[1].startedAt = "2026-10-19T00:00:00Z";
	},
	(f) => {
		f.runs.splice(0, 1);
	},
]) {
	test("requires matching failed source and later successful skill run", async () => {
		const f = fixture("Skill run failed: example");
		change(f);
		expect((await f.run()).wouldClose).toEqual([]);
	});
}
for (const route of ["delegate_tedi", "unknown"]) {
	test("preserves failed delegated Home work", async () => {
		const f = fixture("Question?");
		f.item.sourceSessionKey = "home:example";
		f.item.metadata.homeRunId = "home-run";
		f.home.kernelRoute.routeKind = route;
		expect((await f.run()).wouldClose).toEqual([]);
	});
}
test("rechecks concurrent human activity and Attempts before cancellation", async () => {
	for (const human of [true, false]) {
		const f = fixture();
		f.c.dryRun = false;
		f.tedi.work_item_get.mockImplementation(async () => {
			if (f.tedi.work_item_get.mock.calls.length === 2) {
				if (human)
					f.detail.comments.push({
						authorType: "user",
						createdAt: NOW.toISOString(),
					});
				else f.attempts.data.push({ runtimeState: "running" });
			}
			return f.detail;
		});
		expect((await f.run()).closed).toEqual([]);
	}
});
test("malformed and oversized scans stop before any closure", async () => {
	for (const malformed of [true, false]) {
		const f = fixture();
		f.c.dryRun = false;
		f.tedi.work_items_list.mockImplementation(async () =>
			malformed ? {} : { data: [f.item], pagination: { hasMore: true } },
		);
		await expect(f.run()).rejects.toThrow(
			malformed ? "Malformed" : "truncated",
		);
		expect(f.tedi.cancel_work_item).not.toHaveBeenCalled();
	}
});
test("threshold params cannot weaken the safety windows", async () => {
	const f = fixture();
	f.c.humanHours = 1;
	await expect(f.run()).rejects.toThrow("at least 48");
});
test("preserves idle stubs until strictly past 72 hours", async () => {
	const f = fixture("Automatic stub");
	f.item.description = "Filed automatically: generated";
	f.item.createdAt = "2026-10-22T12:00:00Z";
	expect((await f.run()).wouldClose).toEqual([]);
	f.item.createdAt = "2026-10-22T11:59:59Z";
	expect((await f.run()).wouldClose).toHaveLength(1);
});
test("recognizes the factory health producer's skill reference", async () => {
	const f = fixture("Factory incident: example failed then failed");
	const skill = "11111111-1111-4111-8111-111111111111";
	f.item.metadata = {};
	f.item.description = `factory-daily-health found Example (skill ${skill}) failing two days in a row.`;
	f.runs.forEach((run) => {
		run.skillId = skill;
	});
	expect((await f.run()).wouldClose[0].evidence).toEndWith(
		"/activity/runs/success",
	);
});
test("carries version, comment and Attempt fences to the cancellation endpoint", async () => {
	const f = fixture("Stub");
	f.item.description = "Filed automatically: generated";
	f.c.dryRun = false;
	await f.run();
	expect(f.tedi.cancel_work_item.mock.calls[0][0].hygiene).toEqual({
		expectedWorkItemVersion: 1,
		humanQuietHours: 48,
		noAttempts: true,
	});
});
