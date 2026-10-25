import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import {
	parseWorkerTypesArgs,
	runCommand,
	selectWorkspaces,
} from "./generate-worker-types";

const timers: ReturnType<typeof setTimeout>[] = [];

afterEach(() => {
	mock.restore();
	for (const timer of timers.splice(0)) clearTimeout(timer);
});

function command() {
	const child = new childProcess.ChildProcess();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	Object.defineProperties(child, {
		stdout: { value: stdout },
		stderr: { value: stderr },
	});
	const kill = spyOn(child, "kill").mockReturnValue(true);
	const spawn = spyOn(childProcess, "spawn").mockReturnValue(child);
	const timer = setTimeout(() => {}, 60_000);
	timers.push(timer);
	let fireDeadline = () => {};
	spyOn(globalThis, "setTimeout").mockImplementation(
		Object.assign(
			(...[callback]: Parameters<typeof setTimeout>) => {
				fireDeadline = callback;
				return timer;
			},
			{ __promisify__: setTimeout.__promisify__ },
		),
	);
	const clear = spyOn(globalThis, "clearTimeout");
	const result = runCommand(["wrangler", "types"], import.meta.dir);
	return {
		child,
		stdout,
		stderr,
		kill,
		spawn,
		timer,
		clear,
		result,
		fireDeadline: () => fireDeadline(),
	};
}

describe("Worker type command settlement", () => {
	test("spawn failure clears its deadline and survives late close and deadline callbacks", async () => {
		const run = command();
		run.child.emit("error", new Error("spawn bunx ENOENT"));
		await expect(run.result).rejects.toThrow(
			"could not run `wrangler types`: spawn bunx ENOENT",
		);
		expect(run.clear).toHaveBeenCalledWith(run.timer);
		run.child.emit("close", 0);
		run.fireDeadline();
		expect(run.kill).not.toHaveBeenCalled();
		await expect(run.result).rejects.toThrow("spawn bunx ENOENT");
	});

	test("normal close preserves output and cancels its deadline", async () => {
		const run = command();
		run.stdout.write("generated");
		run.stderr.write("warning");
		run.child.emit("close", 2);
		await expect(run.result).resolves.toEqual({
			code: 2,
			stdout: "generated",
			stderr: "warning",
		});
		expect(run.clear).toHaveBeenCalledWith(run.timer);
		run.fireDeadline();
		run.child.emit("error", new Error("late error"));
		expect(run.kill).not.toHaveBeenCalled();
		expect(run.spawn).toHaveBeenCalledWith(
			"bunx",
			["wrangler", "types"],
			expect.objectContaining({ cwd: import.meta.dir }),
		);
	});

	for (const completed of [false, true]) {
		test(`deadline retains its ${completed ? "completed" : "timeout"} result when kill triggers close`, async () => {
			const run = command();
			if (completed) run.stdout.write("Remember to rerun 'wrangler types'");
			run.kill.mockImplementation(() => {
				run.child.emit("close", 143);
				return true;
			});
			run.fireDeadline();
			const result = await run.result;
			expect(result.code).toBe(completed ? 0 : null);
			if (!completed)
				expect(result.stderr).toContain("did not exit within 45s");
			run.child.emit("error", new Error("late error"));
			run.fireDeadline();
			expect(run.kill).toHaveBeenCalledTimes(1);
		});
	}
});

describe("worker types arguments", () => {
	test("rejects unknown options", () => {
		expect(() => parseWorkerTypesArgs(["--chek"])).toThrow(
			"--chek: unknown option",
		);
	});

	test("parses check, concurrency, and workspace selectors", () => {
		const parsed = parseWorkerTypesArgs([
			"--check",
			"--concurrency=2",
			"api",
			"apps/tedi-runtime",
		]);

		expect(parsed).toEqual({
			checkOnly: true,
			concurrency: 2,
			requested: ["api", "apps/tedi-runtime"],
		});
		expect(
			selectWorkspaces(
				["apps/api", "apps/mcp", "apps/tedi-runtime"],
				parsed.requested,
			),
		).toEqual(["apps/api", "apps/tedi-runtime"]);
	});

	test("keeps generation defaults", () => {
		expect(parseWorkerTypesArgs([])).toEqual({
			checkOnly: false,
			concurrency: 4,
			requested: [],
		});
	});
});
