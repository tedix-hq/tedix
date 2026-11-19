import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refusedMachineCommand } from "./lane-machine-refused";
import { runShellCommand } from "./lane-machine-workspaces";
import {
	answerMachineToolCall,
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

test("with the write tools on, a tedi edits files and runs commands in its own workspace", async () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-machine-write-"));
	roots.push(root);
	const checkout = join(root, "source");
	execFileSync("git", ["init", "-q", "-b", "main", checkout]);
	writeFileSync(join(checkout, "a.txt"), "one\ntwo\n");
	execFileSync("git", ["-C", checkout, "add", "-A"]);
	execFileSync(
		"git",
		[
			"-C",
			checkout,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-q",
			"-m",
			"First commit",
		],
		{ stdio: "ignore" },
	);
	execFileSync("git", [
		"-C",
		checkout,
		"update-ref",
		"refs/remotes/origin/main",
		"HEAD",
	]);
	const options = { checkout, configDir: join(root, "config") };
	const on = machineToolHandlers({ ...options, write: true });
	const call = (tool: string, input: Record<string, unknown>) =>
		answerMachineToolCall(on, tool, input);

	// A machine whose owner did not switch them on has no such tool.
	expect(
		await answerMachineToolCall(
			machineToolHandlers(options),
			"open_workspace",
			{},
		),
	).toEqual({ ok: false, error: "This machine has no open_workspace" });

	const opened = await call("open_workspace", { name: "fix" });
	const workspace = /^workspace: (fix-[0-9a-f]{8})$/m.exec(
		opened.ok ? opened.result : "",
	)?.[1];
	expect(workspace).toBeDefined();
	const folder = join(root, "config", "machine-workspaces", workspace!, "repo");

	expect(
		await call("write_file", { workspace, path: "src/new.txt", content: "x" }),
	).toEqual({ ok: true, result: "Created src/new.txt (1 characters)" });
	expect(
		await call("edit_file", {
			workspace,
			path: "a.txt",
			oldText: "two",
			newText: "2",
		}),
	).toEqual({
		ok: true,
		result: "Replaced 1 occurrence in a.txt, the first at line 2",
	});
	expect(await call("read_file", { workspace, path: "a.txt" })).toMatchObject({
		ok: true,
		result: expect.stringContaining("2\t2"),
	});
	// The source checkout is untouched.
	expect(readFileSync(join(checkout, "a.txt"), "utf8")).toBe("one\ntwo\n");

	expect(
		await call("run_command", { workspace, command: "cat a.txt; exit 3" }),
	).toEqual({ ok: true, result: "Exit code 3\none\n2\n" });
	expect(
		(await call("run_command", { workspace, command: "sudo ls" })).ok,
	).toBe(false);
	expect(refusedMachineCommand("git push --force origin main")).toBeDefined();

	// A command past its timeout is stopped with everything it started.
	const stopped = await runShellCommand("sleep 30 & sleep 30", {
		cwd: folder,
		env: process.env,
		timeoutMs: 300,
	});
	expect(stopped.timedOut).toBe(true);

	expect((await call("close_workspace", { workspace })).ok).toBe(true);
	expect(existsSync(folder)).toBe(false);
}, 60_000);
