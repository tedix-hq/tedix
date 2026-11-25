import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runnerKey,
	writeRunnerDuty,
	type RunnerDuty,
} from "./supervise-runners";
import { dispatchRequestsDirectory } from "./lane-dispatch-wake";
import { refusedMachineCommand } from "./lane-machine-refused";
import {
	adoptMachineWorkspace,
	releaseMachineWorkspace,
	runShellCommand,
} from "./lane-machine-workspaces";
import {
	answerMachineToolCall,
	createMachineToolsLoop,
	MACHINE_TOOL_ACTIVE_MS,
	MACHINE_TOOL_CONNECTED_MS,
	MACHINE_TOOL_IDLE_MS,
	machineToolHandlers,
	type MachineToolClaimInput,
	type MachineSocket,
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

test("a machine answers calls over its connection while it is open and polls when it is not", async () => {
	const listeners = new Map<
		string,
		Parameters<MachineSocket["addEventListener"]>[1]
	>();
	const sent: string[] = [];
	const dialed: string[][] = [];
	const claims: MachineToolClaimInput[] = [];
	const events: string[] = [];
	const reasons: string[] = [];
	const loop = createMachineToolsLoop({
		reporterId: "reporter-1",
		machineName: "studio",
		claim: async (input) => {
			claims.push(input);
			return {
				calls: [],
				connection: {
					url: "wss://api.tedix.test/machines/connect",
					ticket: "t",
				},
			};
		},
		handlers: { read_runner_state: async () => "No runners here" },
		log: (event, reason) => {
			events.push(event);
			reasons.push(reason);
		},
		openSocket: (url, ticket) => {
			dialed.push([url, ticket]);
			return {
				send: (text) => sent.push(text),
				close: () => listeners.get("close")?.({}),
				addEventListener: (type, listener) => listeners.set(type, listener),
			};
		},
	});

	// Until the connection is open the machine polls at its usual pace.
	expect(await loop.cycle()).toBe(MACHINE_TOOL_IDLE_MS);
	expect(dialed).toEqual([["wss://api.tedix.test/machines/connect", "t"]]);
	listeners.get("open")!({});
	expect(await loop.cycle()).toBe(MACHINE_TOOL_CONNECTED_MS);
	expect(dialed).toHaveLength(1);

	// A pushed call is answered on the connection, not with the next claim.
	const call = { callId: "call-1", tool: "read_runner_state", input: {} };
	listeners.get("message")!({ data: JSON.stringify(call) });
	await loop.inFlight();
	expect(sent.map((text) => JSON.parse(text))).toEqual([
		{ callId: "call-1", ok: true, result: "No runners here" },
	]);
	listeners.get("message")!({ data: JSON.stringify({ answered: "call-1" }) });
	expect(loop.idle()).toBe(true);

	// An answer the server did not confirm before the connection dropped is
	// sent with the next claim, and the machine is back to polling.
	listeners.get("message")!({
		data: JSON.stringify({ ...call, callId: "call-2" }),
	});
	await loop.inFlight();
	listeners.get("close")!({
		code: 4001,
		reason: "Replaced by a newer connection",
	});
	expect(await loop.cycle()).toBe(MACHINE_TOOL_ACTIVE_MS);
	expect(claims.at(-1)!.results).toEqual([
		{ callId: "call-2", ok: true, result: "No runners here" },
	]);
	expect(
		events.filter((event) => event.startsWith("machine-connection-")),
	).toEqual(["machine-connection-open", "machine-connection-closed"]);
	expect(reasons.at(-1)).toContain(
		"remote close 4001: Replaced by a newer connection",
	);
});

test("transient claims back off, retain answers and report recovery without failed events", async () => {
	const claims: MachineToolClaimInput[] = [];
	const events: string[][] = [];
	const errors = [
		"SERVICE_UNAVAILABLE: Database temporarily unavailable",
		"Native call deadline elapsed",
		"getaddrinfo ENOTFOUND example.test",
	];
	const loop = createMachineToolsLoop({
		reporterId: "reporter-1",
		machineName: "studio",
		claim: async (input) => {
			claims.push(input);
			if (claims.length === 1)
				return {
					calls: [{ callId: "call-1", tool: "read_runner_state", input: {} }],
				};
			const error = errors[claims.length - 2];
			if (error) throw new Error(error);
			return { calls: [] };
		},
		handlers: { read_runner_state: async () => "ready" },
		log: (event, reason) => events.push([event, reason]),
	});
	await loop.cycle();
	await loop.inFlight();
	for (const ceiling of [1_000, 2_000, 4_000]) {
		const delay = await loop.cycle();
		expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
		expect(delay).toBeLessThanOrEqual(ceiling);
	}
	await loop.cycle();
	await loop.cycle();
	for (const claim of claims.slice(1, 5))
		expect(claim.results).toEqual([
			{ callId: "call-1", ok: true, result: "ready" },
		]);
	expect(claims.at(-1)!.results).toBeUndefined();
	expect(events.filter(([event]) => event !== "machine-tool-answered")).toEqual(
		[
			[
				"machine-tools-retried",
				"after 3 claims: database unavailable (1), claim deadline (1), network (1); last: getaddrinfo ENOTFOUND example.test",
			],
		],
	);
});

test("dark wake defers quietly while sustained outages and permission errors remain failures", async () => {
	const events: string[][] = [];
	let message = "Stored session could not be refreshed (deferred-dark-wake)";
	const loop = createMachineToolsLoop({
		reporterId: "reporter-1",
		machineName: "studio",
		claim: async () => {
			if (message) throw new Error(message);
			return { calls: [] };
		},
		handlers: {},
		log: (event, reason) => events.push([event, reason]),
	});
	await loop.cycle();
	await loop.cycle();
	expect(events.map(([event]) => event)).toEqual(["machine-tools-deferred"]);
	message = "";
	await loop.cycle();
	expect(events.at(-1)![0]).toBe("machine-tools-resumed");
	message = "SERVICE_UNAVAILABLE: Database temporarily unavailable";
	for (let i = 0; i < 10; i++) {
		const delay = await loop.cycle();
		expect(delay).toBeLessThanOrEqual(60_000);
	}
	expect(
		events.filter(([event]) => event === "machine-tools-failed"),
	).toHaveLength(1);
	message = "";
	await loop.cycle();
	expect(events.at(-1)).toEqual([
		"machine-tools-recovered",
		"after 10 claims: database unavailable (10); last: SERVICE_UNAVAILABLE: Database temporarily unavailable",
	]);
	message = "FORBIDDEN: Only the reporting runner may claim";
	expect(await loop.cycle()).toBe(MACHINE_TOOL_IDLE_MS);
	expect(events.at(-1)).toEqual(["machine-tools-failed", message]);
});

test("a suspended ping timer resumes the socket but an awake unresponsive peer is closed", async () => {
	let now = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const handle = setInterval(() => {}, 1_000_000);
	let tick = () => {};
	const timer = spyOn(globalThis, "setInterval").mockImplementation(
		(...[callback, _ms, ...args]: Parameters<typeof setInterval>) => {
			tick = () => callback(...args);
			return handle;
		},
	);
	const listeners = new Map<
		string,
		Parameters<MachineSocket["addEventListener"]>[1]
	>();
	const events: string[][] = [];
	const sent: string[] = [];
	let closes = 0;
	const loop = createMachineToolsLoop({
		reporterId: "reporter-1",
		machineName: "studio",
		claim: async () => ({
			calls: [],
			connection: { url: "wss://example.test", ticket: "t" },
		}),
		handlers: {},
		log: (event, reason) => events.push([event, reason]),
		openSocket: () => ({
			send: (text) => {
				sent.push(text);
			},
			close: () => {
				closes += 1;
			},
			addEventListener: (type, listener) => {
				listeners.set(type, listener);
			},
		}),
	});
	try {
		await loop.cycle();
		listeners.get("open")!({});
		for (let i = 0; i < 3; i++) {
			now += 30_000;
			tick();
		}
		now += 180_000;
		tick();
		expect(closes).toBe(0);
		expect(sent).toEqual(["ping", "ping", "ping", "ping"]);
		listeners.get("message")!({ data: "pong" });
		for (let i = 0; i < 4; i++) {
			now += 30_000;
			tick();
		}
		expect(closes).toBe(1);
		expect(events.slice(1)).toEqual([
			["machine-connection-resumed", "timer gap 180000ms"],
			["machine-connection-closed", "ping timeout; polling"],
		]);
	} finally {
		loop.close();
		clearInterval(handle);
		timer.mockRestore();
		clock.mockRestore();
	}
});

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
	// The runner's folder: its logs may be read, nothing else; a host name is not the folder.
	for (const allowed of [
		"curl -s https://api.tedix.dev/health",
		"tail -n 50 ~/.tedix/dispatchers/a/dispatcher.log",
		"grep -n error ~/.tedix/supervisor.log && ls -la ~/.tedix/",
	])
		expect(refusedMachineCommand(allowed)).toBeUndefined();
	for (const refused of [
		"cat ~/.tedix/credentials.json",
		"cat ~/.tedix/decision-capture/a.session.json",
		"rm ~/.tedix/a.log",
		"cat ~/.tedix/a.log > ~/.tedix/b.log",
		"tail -n 5 ~/.tedix/../.ssh/id.log",
		"cp ~/.tedix/a.log /tmp/x",
	])
		expect(refusedMachineCommand(refused)).toBeDefined();

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

test("linked workspaces edit the lane checkout and release only the link", async () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-machine-lane-"));
	roots.push(root);
	const checkout = join(root, "source");
	const configDir = join(root, "config");
	const repo = join(root, "run");
	execFileSync("git", ["init", "-q", checkout]);
	mkdirSync(repo);
	const call = (tool: string, input: Record<string, unknown>) =>
		answerMachineToolCall(
			machineToolHandlers({ checkout, configDir, write: true }),
			tool,
			input,
		);
	const workspace = await adoptMachineWorkspace(configDir, repo);
	const registration = (id: string) =>
		join(configDir, "machine-workspaces", id);
	const path = "result.txt";
	expect(
		await call("write_file", { workspace, path, content: "result" }),
	).toMatchObject({ ok: true });
	expect(await call("read_file", { workspace, path })).toMatchObject({
		ok: true,
		result: expect.stringContaining("result"),
	});
	symlinkSync(root, join(repo, "outside"));
	expect(
		await call("write_file", {
			workspace,
			path: "outside/escape",
			content: "bad",
		}),
	).toMatchObject({ ok: false });
	expect(await call("close_workspace", { workspace })).toMatchObject({
		ok: true,
	});
	expect(existsSync(registration(workspace))).toBe(false);

	const idle = await adoptMachineWorkspace(configDir, repo);
	utimesSync(registration(idle), new Date(0), new Date(0));
	// Opening a workspace reaps idle entries before trying to resolve its base.
	expect(await call("open_workspace", {})).toMatchObject({ ok: false });
	expect(existsSync(registration(idle))).toBe(false);
	const released = await adoptMachineWorkspace(configDir, repo);
	expect(await releaseMachineWorkspace(configDir, released)).toBe(true);
	expect(existsSync(registration(released))).toBe(false);
	expect(readFileSync(join(repo, path), "utf8")).toBe("result");
});

test("a tedi reads the owner's folders but never credential locations or anything outside the home folder", async () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-machine-home-"));
	roots.push(root);
	const home = join(root, "home");
	const outside = join(root, "outside");
	for (const folder of [
		"Downloads",
		".ssh",
		".tedix",
		"Library/Keychains",
		"Projects/app",
	])
		mkdirSync(join(home, folder), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(home, "Downloads", "notes.txt"), "first\nsecond\n");
	writeFileSync(join(home, ".ssh", "id_ed25519"), "private key\n");
	writeFileSync(join(home, ".tedix", "auth.json"), "{}\n");
	writeFileSync(join(home, "Projects", "app", ".env"), "TOKEN=1\n");
	writeFileSync(join(home, "Projects", "app", "server.pem"), "key\n");
	writeFileSync(join(outside, "secret.txt"), "outside\n");
	symlinkSync(join(home, ".ssh"), join(home, "Downloads", "keys"));
	symlinkSync(outside, join(home, "Downloads", "elsewhere"));
	const options = { checkout: root, configDir: join(home, ".tedix"), home };
	const on = machineToolHandlers({ ...options, write: true });
	const call = (tool: string, input: Record<string, unknown>) =>
		answerMachineToolCall(on, tool, input);

	const listed = await call("list_folder", { path: "~/Downloads" });
	expect(listed.ok && listed.result).toContain("notes.txt");
	const read = await call("read_file", { path: "~/Downloads/notes.txt" });
	expect(read.ok && read.result).toContain("1\tfirst");

	for (const [tool, path] of [
		["list_folder", "~/.ssh"],
		["read_file", "~/.ssh/id_ed25519"],
		["read_file", "~/.tedix/auth.json"],
		["list_folder", "~/Library/Keychains"],
		["read_file", "~/Projects/app/.env"],
		["read_file", "~/Projects/app/server.pem"],
		["read_file", "~/Downloads/keys/id_ed25519"],
		["read_file", "~/Downloads/elsewhere/secret.txt"],
		["read_file", "~/../outside/secret.txt"],
		["list_folder", "/etc"],
		["list_folder", "~/Projects/app/.git"],
		["list_folder", "~/Downloads/../.ssh"],
	] as const) {
		const refused = await call(tool, { path });
		expect([path, refused.ok]).toEqual([path, false]);
		expect(JSON.stringify(refused)).not.toMatch(/private key|outside\\n|TOKEN/);
	}

	// A machine whose owner did not switch the tools on reads only its repository.
	const off = machineToolHandlers(options);
	expect(
		(await answerMachineToolCall(off, "list_folder", { path: "~/Downloads" }))
			.ok,
	).toBe(false);
	expect(
		(
			await answerMachineToolCall(off, "read_file", {
				path: "~/Downloads/notes.txt",
			})
		).ok,
	).toBe(false);
});

test("the runner state lists only runs a running runner is starting or has a process for", async () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-runner-state-"));
	roots.push(root);
	const receipt = (
		runner: string,
		id: string,
		row: Record<string, unknown>,
		ageMinutes = 0,
	) => {
		const path = join(root, "dispatchers", runner, `${id}-1.json`);
		writeFileSync(path, JSON.stringify({ itemId: id, version: 1, ...row }));
		const at = Date.now() / 1000 - ageMinutes * 60;
		utimesSync(path, at, at);
	};
	for (const [runner, pid] of [
		["on", process.pid],
		["off", 2 ** 30],
	] as const) {
		mkdirSync(join(root, "dispatchers", runner), { recursive: true });
		writeFileSync(
			join(root, "dispatchers", runner, "health-source.json"),
			JSON.stringify({ executor: runner, pid }),
		);
	}
	const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
	receipt("on", id(1), { phase: "preparing", model: "m1" }, 2);
	receipt("on", id(2), { phase: "preparing" }, 60);
	receipt("on", id(3), { phase: "preparing", outcome: "failed" });
	receipt("on", id(4), { phase: "running", pid: process.pid });
	receipt("off", id(5), { phase: "preparing" });

	const state = await machineToolHandlers({
		checkout: root,
		configDir: root,
	}).read_runner_state({});

	expect(state).toContain("Live runs: 2\n");
	expect(state).toContain(`${id(1)} preparing, on m1, 2 min`);
	expect(state).toContain(`${id(4)} running, on`);
	expect(state).toContain(
		"Runner off (CLI unknown, not running)\n  Live runs: 0",
	);
});

test("Auto wakes a coordinated product runner and project duties keep their own wake", async () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-auto-wake-"));
	roots.push(root);
	const env = { TEDIX_CONFIG_DIR: root };
	const projectId = "11111111-1111-4111-8111-111111111111";
	const workItemId = "22222222-2222-4222-8222-222222222222";
	const product: RunnerDuty = {
		workspace: "acme",
		organization: "org_acme",
		executor: "codex",
		repo: join(root, "product"),
		coordinated: true,
		enabled: true,
		acceptProposed: false,
	};
	const ops: RunnerDuty = {
		...product,
		executor: "any-local",
		project: "33333333-3333-4333-8333-333333333333",
		repo: join(root, "ops"),
		coordinated: false,
	};
	for (const duty of [product, ops]) {
		writeRunnerDuty(env, duty);
		mkdirSync(
			dispatchRequestsDirectory(join(root, "dispatchers", runnerKey(duty))),
			{ recursive: true },
		);
	}
	const handlers = machineToolHandlers({
		checkout: product.repo,
		configDir: root,
		organization: "org_acme",
		env,
	});
	const request = { workItemId, projectId, executor: "any-local" };
	expect(
		(await answerMachineToolCall(handlers, "dispatch_work_item", request)).ok,
	).toBe(true);
	const productRequest = join(
		dispatchRequestsDirectory(join(root, "dispatchers", runnerKey(product))),
		workItemId,
	);
	expect(existsSync(productRequest)).toBe(true);
	rmSync(productRequest);
	expect(
		(
			await answerMachineToolCall(handlers, "dispatch_work_item", {
				...request,
				projectId: ops.project,
			})
		).ok,
	).toBe(true);
	expect(existsSync(productRequest)).toBe(false);
	expect(
		existsSync(
			join(
				dispatchRequestsDirectory(join(root, "dispatchers", runnerKey(ops))),
				workItemId,
			),
		),
	).toBe(true);
});
