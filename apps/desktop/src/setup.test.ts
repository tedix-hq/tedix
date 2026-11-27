/// <reference types="bun-types" />
import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupHost } from "./setup";
import type { RunOptions, RunResult } from "./shell";

const folder = mkdtempSync(join(tmpdir(), "tedix-task-setup-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const calls: string[][] = [];
let authorized = false;
let approve: (result: RunResult) => void;
let started: () => void;
let loginStarted: Promise<void>;
let starts = 0;
const shell = await import("./shell");
mock.module("./shell", () => ({
	...shell,
	configDir: () => folder,
	findTedix: () => "/fixture/tedix",
	run: async (_file: string, args: string[], options: RunOptions) => {
		calls.push(args);
		if (args.includes("login")) {
			options.onLine?.("https://example.com/authorize");
			const result = new Promise<RunResult>((resolve) => {
				approve = resolve;
				options.onStart?.(() => resolve({ ok: false, output: "cancelled" }));
			});
			started();
			return result;
		}
		if (args.includes("status"))
			return {
				ok: true,
				output: JSON.stringify(
					authorized
						? {
								wouldUse: "stored-login",
								storedLogin: { accessToken: { dct: "org_example" } },
							}
						: { wouldUse: "none" },
				),
			};
		return { ok: true, output: "installed" };
	},
}));
mock.module("electron", () => ({
	app: { getPath: () => folder, getVersion: () => "1.0.0" },
	nativeImage: {},
}));
mock.module("./cli", () => ({
	manageCli: async () => {},
	restoreCli: async () => {},
	readCli: async () => ({ kind: "own", version: "1.0.0", canRestore: false }),
}));
const harness = await import("./harness-target");
mock.module("./harness-target", () => ({
	...harness,
	harnessTarget: () => ({ command: "/fixture/codex" }),
	desktopAppPath: () => undefined,
}));
const { setupAction, setupState } = await import("./setup");
const host: SetupHost = {
	chooseFolder: async () => {
		throw new Error("Non-code tasks must not ask for a project folder");
	},
	appSignIn: async () => {},
	openSignIn: async () => {},
	startRunnersIfStopped: async () => {
		starts++;
	},
	confirmRemove: async () => false,
	tasksChanged: () => {},
};

function begin() {
	authorized = false;
	calls.length = 0;
	starts = 0;
	loginStarted = new Promise((resolve) => {
		started = resolve;
	});
	return setupAction("run-tasks", "codex", host);
}

test("one task-enable action waits for authorization then installs and starts without a folder choice", async () => {
	const enabling = begin();
	await loginStarted;
	expect(starts).toBe(0);
	expect(calls.some((args) => args.includes("--install"))).toBe(false);
	authorized = true;
	approve({ ok: true, output: "Authorized" });
	await enabling;
	const install = calls.find((args) => args.includes("--install"))!;
	expect(install[install.indexOf("--organization") + 1]).toBe("org_example");
	expect(install[install.indexOf("--repo") + 1]).toBe(
		join(folder, "no-project"),
	);
	expect(existsSync(join(folder, "no-project"))).toBe(true);
	expect(starts).toBe(1);
	expect(setupState().steps["run:codex"]?.done).toBeTruthy();
});

test("denied, unconfirmed and cancelled authorization never installs or starts a runner", async () => {
	for (const result of [
		{ ok: false, output: "Authorization denied" },
		{ ok: true, output: "Done without a stored authorization" },
		null,
	]) {
		const enabling = begin();
		await loginStarted;
		if (result) approve(result);
		else await setupAction("cancel", "run:codex", host);
		await enabling;
		expect(calls.some((args) => args.includes("--install"))).toBe(false);
		expect(starts).toBe(0);
		expect(setupState().steps["run:codex"]?.done).toBeUndefined();
	}
});
