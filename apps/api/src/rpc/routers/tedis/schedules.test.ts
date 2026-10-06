import { describe, expect, test } from "vite-plus/test";
import { parseRuntimeSchedules, schedulesFromAdminFetch } from "./schedules";

describe("parseRuntimeSchedules", () => {
	test("maps a well-formed runtime payload to contract schedules", () => {
		const result = parseRuntimeSchedules({
			ok: true,
			tediId: "00000000-0000-0000-0000-000000000001",
			slug: "cto",
			schedules: [
				{
					id: "sched-1",
					callback: "onCronFire",
					name: "weekly-report",
					kind: "cron",
					expr: "0 8 * * 1",
					everyMs: null,
					message: "Run the weekly-report skill",
					sessionTarget: "agent:main:main",
					nextRunAtMs: 1_900_000_000_000,
					nextRunAt: "2030-03-17T17:46:40.000Z",
				},
				{
					id: "sched-2",
					callback: "onCronFire",
					name: null,
					kind: "every",
					expr: null,
					everyMs: 900_000,
					message: "poll inbox",
					sessionTarget: null,
					nextRunAtMs: null,
					nextRunAt: null,
				},
			],
		});
		expect(result.warning).toBeUndefined();
		expect(result.schedules).toHaveLength(2);
		expect(result.schedules[0]).toEqual({
			id: "sched-1",
			callback: "onCronFire",
			name: "weekly-report",
			kind: "cron",
			expr: "0 8 * * 1",
			everyMs: null,
			message: "Run the weekly-report skill",
			sessionTarget: "agent:main:main",
			nextRunAt: "2030-03-17T17:46:40.000Z",
		});
		expect(result.schedules[1]?.kind).toBe("every");
		expect(result.schedules[1]?.everyMs).toBe(900_000);
	});

	test("unexpected payload shapes fail soft to empty + warning", () => {
		for (const bad of [
			null,
			{},
			{ ok: false, schedules: [] },
			{ ok: true, schedules: "nope" },
			"garbage",
		]) {
			const result = parseRuntimeSchedules(bad);
			expect(result.schedules).toEqual([]);
			expect(result.warning).toBe(
				"Runtime returned an unexpected schedules payload",
			);
		}
	});

	test("skips unrecognized rows but keeps the valid ones, with a warning", () => {
		const result = parseRuntimeSchedules({
			ok: true,
			schedules: [
				{ id: "good", callback: "onCronFire", kind: "at" },
				{ id: "bad-kind", callback: "onCronFire", kind: "lunar" },
				{ callback: "onCronFire", kind: "cron" }, // no id
				null,
			],
		});
		expect(result.schedules).toHaveLength(1);
		expect(result.schedules[0]?.id).toBe("good");
		// Optional fields degrade to explicit nulls, not undefined.
		expect(result.schedules[0]?.expr).toBeNull();
		expect(result.schedules[0]?.nextRunAt).toBeNull();
		expect(result.warning).toBe("Skipped 3 unrecognized schedule rows");
	});

	test("surfaces the DO's partial-read error as a warning", () => {
		const result = parseRuntimeSchedules({
			ok: true,
			schedules: [],
			error: "getSchedules unavailable",
		});
		expect(result.schedules).toEqual([]);
		expect(result.warning).toBe("Partial read: getSchedules unavailable");
	});
});

describe("schedulesFromAdminFetch", () => {
	test("runtime unreachable (fetch error/timeout) → empty list + warning", () => {
		const result = schedulesFromAdminFetch({
			error: "timeout_after_10000ms",
		});
		expect(result.schedules).toEqual([]);
		expect(result.warning).toBe("Runtime unreachable: timeout_after_10000ms");
	});

	test("unreachable warning redacts internal URLs", () => {
		const result = schedulesFromAdminFetch({
			error: "fetch failed for https://cto.tedi.tedix.dev/__admin/schedules",
		});
		expect(result.warning).not.toContain("tedi.tedix.dev");
		expect(result.warning).toContain("[internal]");
	});

	test("non-2xx runtime response → empty list + status warning", () => {
		const result = schedulesFromAdminFetch({
			ok: false,
			status: 503,
			json: { error: "Service Unavailable" },
		});
		expect(result.schedules).toEqual([]);
		expect(result.warning).toBe("Runtime returned status 503");
	});

	test("2xx response delegates to the payload parser", () => {
		const result = schedulesFromAdminFetch({
			ok: true,
			status: 200,
			json: {
				ok: true,
				schedules: [
					{ id: "s1", callback: "onCronFire", kind: "cron", expr: "0 8 * * 1" },
				],
			},
		});
		expect(result.schedules).toHaveLength(1);
		expect(result.schedules[0]?.expr).toBe("0 8 * * 1");
		expect(result.warning).toBeUndefined();
	});
});
