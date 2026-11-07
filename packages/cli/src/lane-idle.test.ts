import { expect, it, spyOn } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LaneDispatcher,
	parseServeOptions,
	type DispatchItem,
} from "./lane-serve";
import {
	runnerDutyFromServeOptions,
	runnerServeArgs,
} from "./supervise-runners";
import { idleReason, observeUnavailableRunners } from "./lane-idle";
import {
	writeDispatcherHealthSource,
	type LocalDispatcherHealth,
} from "./dispatcher-health";
const scope = { workspace: "acme", organization: "org-acme" };
it("retains a configured takeover interval across service installation", () => {
	const args = [
		"--executor",
		"codex",
		"--idle-takeover-minutes",
		"20",
		"--workspace",
		"acme",
		"--organization",
		"org-acme",
		"--repo",
		"/fictional/repo",
	];
	const options = parseServeOptions(args, {});
	const duty = runnerDutyFromServeOptions(options);
	expect(duty.idleTakeoverMinutes).toBe(20);
	expect(runnerServeArgs(duty)).toContain("--idle-takeover-minutes");
	expect(runnerServeArgs(duty)).toContain("20");
	expect(() =>
		parseServeOptions([...args, "--idle-takeover-minutes", "0"], {}),
	).toThrow();
});
const report: LocalDispatcherHealth = {
	...scope,
	reporterId: "host",
	executor: "codex",
	lane: "lane",
	running: true,
	observedAt: "2026-11-07T22:00:00Z",
	lastAdmissionAt: null,
	slotsInUse: 1,
	slotsTotal: 1,
	topReason: null,
};
it("requires continuous unavailable capacity and resets when a runner has a free slot", () => {
	const start = observeUnavailableRunners([report], new Map(), scope, 1000);
	expect(
		observeUnavailableRunners([report], start, scope, 901000).get("codex"),
	).toEqual({ since: 1000, reason: "busy" });
	expect(
		observeUnavailableRunners(
			[report, { ...report, lane: "other", slotsInUse: 0 }],
			start,
			scope,
			2000,
		).size,
	).toBe(0);
	expect(observeUnavailableRunners([], start, scope, 2000).size).toBe(0);
	expect(
		observeUnavailableRunners(
			[{ ...report, organization: "other" }],
			start,
			scope,
			2000,
		).size,
	).toBe(0);
	expect(
		observeUnavailableRunners(
			[{ ...report, running: false }],
			start,
			scope,
			2000,
		).get("codex"),
	).toEqual({ since: 2000, reason: "unreachable" });
});
it("distinguishes held, person and coordinator skips", () => {
	expect(idleReason("Automatic execution held after 3 failed Attempts")).toBe(
		"held",
	);
	expect(
		idleReason("Existing Interaction has no verified resolving human response"),
	).toBe("waitingOnPerson");
	expect(idleReason("Work has no ready coordinator selection")).toBe(
		"noCoordinator",
	);
});

it("reports no-coordinator items without widening admission reads, and samples once a minute", async () => {
	const directory = mkdtempSync(join(tmpdir(), "lane-idle-report-"));
	try {
		const options = {
			executor: "codex" as const,
			max: 1,
			coordinated: true,
			acceptProposed: false,
			rules: "rules",
			repo: directory,
			scope: ["--workspace", "acme", "--organization", "org-acme"],
			once: true,
			install: false,
		};
		writeDispatcherHealthSource(directory, options);
		let samples = 0;
		const dispatcher = new LaneDispatcher(options, directory, {
			darkWake: () => false,
			health: () => [],
			devinAvailable: () => true,
			available: () => true,
			budgets: () => ({}),
			freeDiskBytes: () => 100 * 1024 ** 3,
			cli: async <T>(args: string[]): Promise<T> => {
				const verb = args[5];
				if (verb === "dispatch-list") {
					const input = JSON.parse(args[args.indexOf("--input") + 1]!);
					expect(input.dispatchReadyOnly).toBe(true);
				}
				if (verb === "dispatch-idle-list") {
					samples++;
					return {
						data: [
							{
								id: "11111111-1111-4111-8111-111111111111",
								disposition: "accepted",
								projectId: "project",
								metadata: {
									executor: "codex",
									laneDispatch: { state: "held" },
								},
							},
						],
						pagination: { hasMore: false },
					} as T;
				}
				return { data: [], pagination: { hasMore: false } } as T;
			},
		});
		await dispatcher.tick();
		await dispatcher.tick();
		expect(samples).toBe(1);
		const source = JSON.parse(
			readFileSync(join(directory, "health-source.json"), "utf8"),
		);
		expect(source.idle).toMatchObject({
			noCoordinator: 1,
			held: 0,
			waitingOnPerson: 0,
			complete: true,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it.each([
	"busy",
	"unreachable",
	"held",
	"retained worktree",
	"quota",
	"free donor",
])("takes eligible donor Work only after 15 minutes: %s", async (state) => {
	const directory = mkdtempSync(join(tmpdir(), "lane-idle-"));
	let now = Date.parse("2026-11-07T22:00:00.000Z");
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		const own = join(directory, "recipient");
		mkdirSync(own);
		const donor = {
			...report,
			running: state !== "unreachable",
			slotsInUse: state === "free donor" ? 0 : 1,
		};
		const item: DispatchItem = {
			id: "11111111-1111-4111-8111-111111111111",
			version: 3,
			title: "Fix widget",
			description: "Correct sizing",
			workKind: "coding",
			disposition: "accepted",
			projectId: "22222222-2222-4222-8222-222222222222",
			startAt: null,
			acceptanceContract: { version: 1, doneLooksLike: "Sizing corrected" },
			metadata: { executor: "codex", laneDispatch: { state: "ready" } },
			accountableOwnerType: null,
			accountableOwnerId: null,
		};
		if (state === "held" || state === "retained worktree") {
			mkdirSync(join(directory, "lane"));
			writeFileSync(
				join(directory, "lane", `${item.id}-3.json`),
				JSON.stringify({
					held: state === "held",
					repo: state === "retained worktree" ? directory : undefined,
				}),
			);
		}
		const assignments: unknown[] = [];
		const dispatcher = new LaneDispatcher(
			{
				executor: "opencode",
				max: 1,
				coordinated: true,
				acceptProposed: false,
				rules: "rules",
				repo: own,
				scope: ["--workspace", "acme", "--organization", "org-acme"],
				once: true,
				install: false,
			},
			own,
			{
				darkWake: () => false,
				health: () => [donor],
				devinAvailable: () => true,
				available: () => true,
				freeDiskBytes: () => 100 * 1024 ** 3,
				budgets: () =>
					state === "quota"
						? {
								opencode: {
									source: "native",
									observedAt: now,
									remainingPercent: 1,
								},
							}
						: {},
				cli: async <T>(args: string[]): Promise<T> => {
					const verb = args[5];
					const inputAt = args.indexOf("--input");
					const input = inputAt < 0 ? {} : JSON.parse(args[inputAt + 1]!);
					if (verb === "dispatch-list")
						return {
							data: input.executor === "codex" ? [item] : [],
							pagination: { hasMore: false },
						} as T;
					if (verb === "dispatch-reassign") {
						assignments.push(input);
						return item as T;
					}
					return {} as T;
				},
			},
		);
		await dispatcher.tick();
		expect(assignments).toHaveLength(0);
		now += 14 * 60_000;
		await dispatcher.tick();
		expect(assignments).toHaveLength(0);
		now += 60_000;
		await dispatcher.tick();
		if (state === "busy" || state === "unreachable")
			expect(assignments).toEqual([
				expect.objectContaining({
					executor: "opencode",
					expectedWorkItemVersion: 3,
					idleReassignment: expect.objectContaining({
						fromExecutor: "codex",
						reason: state,
						minimumIdleMinutes: 15,
					}),
				}),
			]);
		else expect(assignments).toHaveLength(0);
	} finally {
		clock.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	}
});
