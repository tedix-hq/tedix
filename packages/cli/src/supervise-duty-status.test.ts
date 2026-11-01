import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DUTY_STATUS_FILE,
	readDutyStatuses,
	recordDutyStatus,
} from "./supervise-duty-status";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "duty-status-"));
	directories.push(dir);
	return { env: { TEDIX_CONFIG_DIR: dir }, path: join(dir, DUTY_STATUS_FILE) };
}
const identity = {
	id: "fixture",
	kind: "service" as const,
	workspace: "fixture",
	organization: "org_fixture",
	executor: "codex",
};

test("updating one duty retains other duties and expires restart history", () => {
	const f = fixture();
	recordDutyStatus(
		f.env,
		identity,
		{ restarts: [0, 3_600_000], lastExitCode: 9 },
		3_600_001,
	);
	recordDutyStatus(
		f.env,
		{ ...identity, id: "lead", kind: "task" },
		{ state: "running" },
		3_600_002,
	);
	recordDutyStatus(f.env, identity, { state: "waiting" }, 3_600_003);
	expect(readDutyStatuses(f.env)).toHaveLength(2);
	expect(readDutyStatuses(f.env)[0]).toMatchObject({
		restarts: [3_600_000],
		lastExitCode: 9,
		state: "waiting",
	});
});

test("an unreadable history is preserved rather than replaced with fabricated zeros", () => {
	const f = fixture();
	writeFileSync(f.path, "{invalid");
	expect(() =>
		recordDutyStatus(f.env, identity, { state: "running" }, Date.now()),
	).toThrow();
	expect(readFileSync(f.path, "utf8")).toBe("{invalid");
});

test("a retry waiting to start is not counted as an actual restart", () => {
	const f = fixture();
	recordDutyStatus(
		f.env,
		identity,
		{ lastRunAt: new Date(1000).toISOString(), state: "running" },
		1000,
	);
	recordDutyStatus(f.env, identity, { exits: [2000], state: "waiting" }, 2000);
	expect(readDutyStatuses(f.env)[0]?.restarts).toEqual([]);
	recordDutyStatus(
		f.env,
		identity,
		{ lastRunAt: new Date(3000).toISOString(), state: "running" },
		3000,
	);
	expect(readDutyStatuses(f.env)[0]?.restarts).toEqual([3000]);
});

test("a continuing problem retains its first observation until explicitly cleared", () => {
	const f = fixture();
	const first = recordDutyStatus(
		f.env,
		identity,
		{ lastProblem: "Runner exited" },
		1000,
	);
	recordDutyStatus(f.env, identity, { state: "running" }, 2000);
	const next = recordDutyStatus(
		f.env,
		identity,
		{ lastProblem: "Runner exited again" },
		3000,
	);
	expect(next.problemSince).toBe(first.problemSince);
	expect(
		recordDutyStatus(f.env, identity, { lastProblem: null }, 4000).problemSince,
	).toBeNull();
});
