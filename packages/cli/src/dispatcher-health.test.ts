import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDutyStatus } from "./supervise-duty-status";
import {
	collectDispatcherHealth,
	recordDispatcherAdmission,
	recordDispatcherCompletion,
	recordDispatcherNextCheck,
	recordDispatcherPreparing,
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
	test("joins same-machine duty history without inventing native slot observations", () => {
		const { root, directory } = lane();
		const env = { TEDIX_CONFIG_DIR: root };
		const now = Date.now();
		writeDispatcherHealthSource(directory, {
			scope: ["--workspace", "fixture", "--organization", "org_fixture"],
			executor: "fixture-runner",
			max: 2,
		});
		const identity = {
			id: "lane-key",
			kind: "service" as const,
			workspace: "fixture",
			organization: "org_fixture",
			executor: "fixture-runner",
		};
		recordDutyStatus(
			env,
			identity,
			{ state: "waiting", lastExitCode: 7, lastProblem: "Runner exited" },
			now,
		);
		recordDutyStatus(
			env,
			{ ...identity, id: "lead", kind: "task" },
			{ state: "running" },
			now,
		);
		const reports = collectDispatcherHealth(env, now);
		expect(reports).toHaveLength(2);
		expect(reports[0]?.reporterId).toBe(reports[1]?.reporterId);
		expect(reports.find((row) => row.lane === "lane-key")?.duty).toMatchObject({
			lastExitCode: 7,
			state: "waiting",
			restartsLastHour: 0,
		});
		expect(reports.find((row) => row.duty?.id === "lead")?.duty?.state).toBe(
			"running",
		);
	});
	test.each(["skipped", "completion-retained", "telemetry-retained"])(
		"collects repeated %s reasons",
		(event) => {
			const { root, directory } = lane();
			writeDispatcherHealthSource(
				directory,
				{
					scope: ["--workspace", "connect", "--organization", "org_example"],
					executor: "alternate-runner",
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
						event,
						reason:
							"Session label clash for 11111111-1111-4111-8111-111111111111",
					},
					{
						at: "2026-10-30T10:02:00.000Z",
						event,
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
					organization: "org_example",
					executor: "alternate-runner",
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
		},
	);

	test("reports a stopped dispatcher without stale occupied slots", () => {
		const { root, directory } = lane();
		writeDispatcherHealthSource(
			directory,
			{
				scope: ["--workspace", "connect", "--organization", "org_example"],
				executor: "fixture-runner",
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

	test("preserves a real admission through log rotation and dispatcher restart", () => {
		const { root, directory } = lane();
		const options = {
			scope: ["--workspace", "connect", "--organization", "org_example"],
			executor: "fixture-runner",
			max: 2,
		};
		writeDispatcherHealthSource(directory, options);
		const at = "2026-10-30T10:00:00.000Z";
		recordDispatcherAdmission(directory, at);
		writeFileSync(join(directory, "dispatcher.log"), "x".repeat(300_000));
		writeDispatcherHealthSource(directory, options, process.pid + 1);
		const [report] = collectDispatcherHealth({ TEDIX_CONFIG_DIR: root });
		expect(report?.lastAdmissionAt).toBe(at);
		recordDispatcherAdmission(directory, "2026-10-30T11:00:00.000Z");
		expect(
			collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })[0]?.lastAdmissionAt,
		).toBe(at);
		writeDispatcherHealthSource(directory, {
			...options,
			executor: "alternate-runner",
		});
		expect(
			collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })[0]?.lastAdmissionAt,
		).toBeNull();
	});

	test("uses the newest persisted or log admission without moving backwards", () => {
		const { root, directory } = lane();
		writeDispatcherHealthSource(directory, {
			scope: ["--workspace", "connect", "--organization", "org_example"],
			executor: "fixture-runner",
			max: 2,
		});
		recordDispatcherAdmission(directory, "2026-10-30T10:00:00.000Z");
		recordDispatcherAdmission(directory, "2026-10-30T09:00:00.000Z");
		writeFileSync(
			join(directory, "dispatcher.log"),
			JSON.stringify({ at: "2026-10-30T11:00:00.000Z", event: "admitted" }),
		);
		expect(
			collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })[0]?.lastAdmissionAt,
		).toBe("2026-10-30T11:00:00.000Z");
	});

	test("resets preparation on restart and rejects updates from a different process", () => {
		const { root, directory } = lane();
		const options = {
			scope: ["--workspace", "connect", "--organization", "org_example"],
			executor: "fixture-runner",
			max: 3,
		};
		writeDispatcherHealthSource(directory, options);
		recordDispatcherPreparing(directory, 2);
		expect(
			collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })[0]?.slotsInUse,
		).toBe(2);
		recordDispatcherPreparing(directory, 3, process.pid + 1);
		expect(
			collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })[0]?.slotsInUse,
		).toBe(2);
		writeDispatcherHealthSource(directory, options);
		expect(
			collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })[0]?.slotsInUse,
		).toBe(0);
	});

	test("ignores malformed and pre-descriptor lane directories", () => {
		const { root, directory } = lane();
		writeFileSync(join(directory, "health-source.json"), "not json");
		expect(collectDispatcherHealth({ TEDIX_CONFIG_DIR: root })).toEqual([]);
	});
});

describe("generic task activity", () => {
	const one = "11111111-1111-4111-8111-111111111111";
	const two = "22222222-2222-4222-8222-222222222222";
	const three = "33333333-3333-4333-8333-333333333333";
	function fixture() {
		const { root, directory } = lane();
		const env = { TEDIX_CONFIG_DIR: root };
		const options = {
			scope: ["--workspace", "example", "--organization", "org_example"],
			executor: "custom.build-agent",
			max: 4,
		};
		writeDispatcherHealthSource(directory, options);
		recordDutyStatus(
			env,
			{
				id: "lane-key",
				kind: "service",
				workspace: "example",
				organization: "org_example",
				executor: options.executor,
			},
			{ state: "running" },
			Date.now(),
		);
		const activity = () => collectDispatcherHealth(env)[0]!.duty!.activity!;
		const receipt = (id: string, version: number, row: object) =>
			writeFileSync(
				join(directory, `${id}-${version}.json`),
				JSON.stringify(row),
			);
		return { root, directory, env, options, activity, receipt };
	}
	test("reports concurrent work, exact waits and the latest receipt version without provider switches", () => {
		const f = fixture();
		f.receipt(one, 1, { phase: "running", pid: process.pid });
		f.receipt(one, 2, {
			phase: "settled",
			outcome: "succeeded",
			completionPending: false,
		});
		f.receipt(two, 1, {
			phase: "running",
			pid: process.pid,
			nativeActivity: {
				state: "provider_waiting",
				observedAt: new Date().toISOString(),
			},
		});
		f.receipt(three, 1, {
			phase: "deferred",
			admissionState: "unknown",
			retryAt: Date.now() + 60_000,
		});
		expect(f.activity().current).toMatchObject([
			{
				id: two,
				phase: "working",
				nativeActivity: { state: "provider_waiting" },
			},
		]);
		expect(f.activity().waiting).toMatchObject([
			{ id: three, reason: "confirmation" },
		]);
		expect(f.activity().lastCompleted).toBeNull();
		f.receipt(one, 3, { phase: "settling", pid: 2_000_000_000 });
		expect(f.activity().currentCount).toBe(2);
		expect(f.activity().current).toContainEqual({
			id: one,
			phase: "finishing",
		});
	});
	test("keeps working tasks and admission waits visible ahead of retained completion and held rows", () => {
		const f = fixture();
		for (let n = 1; n <= 4; n++) {
			f.receipt(`00000000-0000-4000-8000-00000000000${n}`, 1, {
				phase: "settled",
				outcome: "succeeded",
				completionPending: true,
			});
			f.receipt(`10000000-0000-4000-8000-00000000000${n}`, 1, {
				phase: "deferred",
				held: true,
			});
		}
		f.receipt(two, 1, { phase: "running", pid: process.pid });
		f.receipt(three, 1, { phase: "preparing", admissionState: "unknown" });
		const activity = f.activity();
		expect(activity.current[0]).toEqual({ id: two, phase: "working" });
		expect(activity.current[1]).toEqual({ id: three, phase: "starting" });
		expect(activity.currentCount).toBe(6);
		expect(activity.waiting[0]).toMatchObject({
			id: three,
			reason: "confirmation",
		});
		expect(activity.waiting).toHaveLength(3);
	});
	test("keeps a confirmed completion across restart and never replaces it with older observations", () => {
		const f = fixture();
		const latest = "2026-11-01T10:00:00.000Z";
		recordDispatcherCompletion(f.directory, one, latest);
		recordDispatcherCompletion(f.directory, two, "2026-10-30T10:00:00.000Z");
		recordDispatcherNextCheck(f.directory, "2026-11-01T11:00:00.000Z");
		expect(f.activity().lastCompleted).toEqual({
			id: one,
			completedAt: latest,
		});
		expect(f.activity().nextCheckAt).toBe("2026-11-01T11:00:00.000Z");
		writeDispatcherHealthSource(f.directory, f.options);
		expect(f.activity().lastCompleted?.id).toBe(one);
		expect(f.activity().nextCheckAt).toBeNull();
		writeDispatcherHealthSource(f.directory, {
			...f.options,
			scope: ["--workspace", "example", "--organization", "org_other"],
		});
		expect(collectDispatcherHealth(f.env)[0]?.duty).toBeUndefined();
	});
	test("keeps configured scheduled duties distinct", () => {
		const f = fixture();
		for (const id of ["daily-review", "custom-maintenance"])
			recordDutyStatus(
				f.env,
				{
					id,
					kind: "task",
					workspace: "example",
					organization: "org_example",
					executor: "tenant.runner",
				},
				{ state: "waiting" },
				Date.now(),
			);
		const tasks = collectDispatcherHealth(f.env).filter(
			(r) => r.duty?.kind === "task",
		);
		expect(new Set(tasks.map((r) => r.lane)).size).toBe(2);
	});
});
