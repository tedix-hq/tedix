import { describe, expect, it } from "bun:test";
import { holdAwake } from "./supervise-awake";

function fakeSpawn() {
	const calls: { command: string; args: string[] }[] = [];
	let killed = 0;
	const spawn = (command: string, args: string[]) => {
		calls.push({ command, args });
		return {
			pid: 42,
			kill: () => {
				killed += 1;
				return true;
			},
			on: () => undefined,
		};
	};
	return { spawn, calls, killed: () => killed };
}

describe("holdAwake", () => {
	it("holds idle and on-power sleep off for the supervisor's lifetime on macOS", () => {
		const fake = fakeSpawn();
		const logs: string[] = [];
		const release = holdAwake((m) => logs.push(m), {
			platform: "darwin",
			pid: 1234,
			spawn: fake.spawn,
		});
		expect(fake.calls).toEqual([
			{ command: "/usr/bin/caffeinate", args: ["-i", "-s", "-w", "1234"] },
		]);
		expect(logs[0]).toContain("keep-awake");
		release();
		expect(fake.killed()).toBe(1);
	});

	it("does nothing on other platforms", () => {
		const fake = fakeSpawn();
		holdAwake(() => undefined, { platform: "linux", spawn: fake.spawn })();
		expect(fake.calls).toEqual([]);
		expect(fake.killed()).toBe(0);
	});
});
