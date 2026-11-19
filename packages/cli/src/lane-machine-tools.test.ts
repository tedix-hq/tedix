import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMachineToolsLoop,
	MACHINE_TOOL_ACTIVE_MS,
	MACHINE_TOOL_IDLE_MS,
	machineToolHandlers,
	type MachineToolClaimInput,
} from "./lane-machine-tools";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("a runner claims calls, answers them from main and sends the answers with its next claim", async () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-machine-tools-"));
	roots.push(root);
	const origin = join(root, "origin.git");
	const checkout = join(root, "source");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", checkout, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.test",
				GIT_COMMITTER_NAME: "fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.test",
			},
		});
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "ignore" });
	mkdirSync(join(checkout, "src"));
	writeFileSync(join(checkout, "src", "a.ts"), "one\ntwo needle\nthree\n");
	symlinkSync("/etc/hosts", join(checkout, "escape"));
	git("checkout", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "First commit");
	git("push", "-q", "origin", "main");
	const head = git("rev-parse", "HEAD").trim();
	// Unsaved work in the folder is never what a tedi reads.
	writeFileSync(join(checkout, "src", "a.ts"), "edited in the folder\n");

	const claims: MachineToolClaimInput[] = [];
	const queued = [
		{ tool: "read_file", input: { path: "src/a.ts", endLine: 2 } },
		{ tool: "read_file", input: { path: "escape" } },
		{ tool: "read_file", input: { path: "../outside" } },
		{ tool: "search_code", input: { pattern: "needle|absent" } },
		{ tool: "list_commits", input: {} },
		{ tool: "read_commit", input: { sha: head.slice(0, 8) } },
	].map((call, index) => ({ callId: `call-${index}`, ...call }));
	const loop = createMachineToolsLoop({
		reporterId: "reporter-1",
		machineName: "studio",
		claim: async (input) => {
			claims.push(input);
			return { calls: claims.length === 1 ? queued : [] };
		},
		handlers: machineToolHandlers({ checkout, configDir: root }),
		log: () => {},
	});

	expect(MACHINE_TOOL_IDLE_MS).toBe(10_000);
	expect(await loop.cycle()).toBe(MACHINE_TOOL_ACTIVE_MS);
	await loop.inFlight();
	await loop.cycle();
	await loop.cycle();

	expect(claims[0]).toEqual({
		reporterId: "reporter-1",
		machineName: "studio",
		limit: 5,
	});
	const results = Object.fromEntries(
		claims[1]!.results!.map(({ callId, ...result }) => [callId, result]),
	);
	expect(results["call-0"]).toEqual({
		ok: true,
		result: `src/a.ts at ${head.slice(0, 9)}, lines 1-2 of 3\n1\tone\n2\ttwo needle`,
	});
	expect(results["call-1"]).toEqual({
		ok: false,
		error: "escape is a link; links are not followed",
	});
	expect(results["call-2"]?.ok).toBe(false);
	expect(results["call-3"]).toEqual({
		ok: true,
		result: "src/a.ts:2:two needle",
	});
	expect(results["call-4"]?.result).toContain("First commit");
	expect(results["call-5"]?.result).toContain("+two needle");
	// An answer is sent once.
	expect(claims[2]!.results).toBeUndefined();
}, 60_000);
