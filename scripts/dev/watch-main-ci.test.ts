import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";
import { observeCiCompletion } from "./watch-main-ci.mjs";

const pushedSha = "a".repeat(40);
const descendant = "b".repeat(40);
type Run = {
	id: number;
	head_sha: string;
	status: string;
	conclusion: string | null;
};
const green = (sha = pushedSha): Run => ({
	id: 1,
	head_sha: sha,
	status: "completed",
	conclusion: "success",
});

function fixture(polls: Run[][], included = true) {
	let time = 0,
		poll = 0;
	const notifications: Run[] = [];
	const comparisons: string[] = [];
	return {
		notifications,
		comparisons,
		options: {
			pushedSha,
			readRuns: async () => polls[Math.min(poll++, polls.length - 1)]!,
			includes: async (_base: string, head: string) => {
				comparisons.push(head);
				return included;
			},
			notify: async (run: Run) => {
				notifications.push(run);
			},
			now: () => time,
			sleep: async (ms: number) => {
				time += ms;
			},
			intervalMs: 10,
			timeoutMs: 30,
			log: () => {},
		},
	};
}

test("notifies after exact certification without another ancestry request", async () => {
	const f = fixture([
		[{ ...green(), status: "in_progress", conclusion: null }],
		[green()],
	]);
	expect(await observeCiCompletion(f.options)).toEqual({
		sha: pushedSha,
		runId: 1,
	});
	expect(f.notifications).toHaveLength(1);
	expect(f.comparisons).toEqual([]);
});

test("coalesced pushes notify on a certified descendant, not an older green", async () => {
	const old = "c".repeat(40);
	const f = fixture([
		[{ ...green(), conclusion: "cancelled" }, green(old)],
		[green(descendant)],
	]);
	f.options.includes = async (_base, head) => head === descendant;
	expect((await observeCiCompletion(f.options)).sha).toBe(descendant);
	expect(f.notifications.map((run) => run.head_sha)).toEqual([descendant]);
});

test("a newer failed or pending attempt prevents reuse of that SHA's old success", async () => {
	for (const newest of [
		{ ...green(), id: 2, conclusion: "failure" },
		{ ...green(), id: 2, status: "in_progress", conclusion: null },
	]) {
		const f = fixture([[newest, green()]]);
		await expect(observeCiCompletion(f.options)).rejects.toThrow("timed out");
		expect(f.notifications).toEqual([]);
	}
});

test("transient notification errors retry; persistent errors leave fallback active", async () => {
	const f = fixture([[green()]]);
	let calls = 0;
	f.options.notify = async () => {
		if (++calls === 1) throw new Error("network");
	};
	expect((await observeCiCompletion(f.options)).sha).toBe(pushedSha);
	expect(calls).toBe(2);
	f.options.readRuns = async () => {
		throw new Error("GitHub unavailable");
	};
	await expect(observeCiCompletion(f.options)).rejects.toThrow(
		"fallback remains active",
	);
});

test("evaluated snapshot source runs outside the checkout and uses existing gh auth", () => {
	const root = mkdtempSync(join(tmpdir(), "ci-completion-"));
	try {
		const gh = join(root, "gh");
		const dispatch = join(root, "dispatch.json");
		const run = {
			...green(),
			head_branch: "main",
			head_repository: { full_name: "tedix-hq/tedix" },
		};
		writeFileSync(
			gh,
			`#!/bin/sh\ncase "$*" in\n*"/dispatches"*) cat > "$DISPATCH_FILE" ;;\n*"/runs?"*) printf '%s\\n' '${JSON.stringify({ workflow_runs: [run] })}' ;;\n*) exit 1 ;;\nesac\n`,
		);
		chmodSync(gh, 0o755);
		const result = spawnSync(
			process.execPath,
			[
				"--eval",
				readFileSync(new URL("./watch-main-ci.mjs", import.meta.url), "utf8"),
			],
			{
				cwd: root,
				env: {
					...detachedGitEnv(),
					PATH: root + delimiter + process.env.PATH,
					TEDIX_CI_PUSHED_SHA: pushedSha,
					DISPATCH_FILE: dispatch,
				},
				encoding: "utf8",
				timeout: 5000,
			},
		);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(JSON.parse(readFileSync(dispatch, "utf8"))).toEqual({
			event_type: "product-ci-completed",
			client_payload: { certified_sha: pushedSha, run_id: 1 },
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
