import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
	isMachineHomePath,
	MACHINE_HOME_TOOL_NAMES,
	MACHINE_READ_TOOL_NAMES,
	MACHINE_TOOL_NAMES,
	MACHINE_TOOL_RESULT_MAX_CHARS,
	MACHINE_WRITE_TOOL_NAMES,
	parseMachineToolInput,
	type MachineToolInput,
	type MachineToolName,
} from "@tedix/api-contract/schemas/machines";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { scrubText } from "@tedix/context-core/trace-safety";
import { resolveStoredLoginAuth } from "./auth-resolve";
import { getCurrentWorkspace } from "./credential-store";
import { fileDiscoveryCache } from "./discovery-cache";
import { dispatcherReporterId } from "./dispatcher-health";
import { TedixHomeClient } from "./home-client";
import { laneChildEnv } from "./lane-child-env";
import { laneCommand } from "./lane-command";
import { dispatchRequestsDirectory } from "./lane-dispatch-wake";
import { runStepToolMissing } from "./lane-heartbeat";
import { machineHome } from "./lane-machine-home";
import { machineWorkspaces } from "./lane-machine-workspaces";
import { beginFileLock } from "./local-file-lock";
import { fileNativeBootstrapCache } from "./native-bootstrap-cache";
import { parseOptions } from "./options";
import { resolveOrganizationTarget } from "./organization-target";
import {
	readRunnerDuties,
	runnersForWork,
	RUNNER_UPDATE_EXIT_CODE,
	runnerKey,
	type RunnerDuty,
} from "./supervise-runners";
import { callConfiguredNativeTool } from "./work-native";
import type { NativeToolContext } from "./work";

/**
 * Machine tools: a tedi asks a named machine to read something, the call is
 * queued on the server, and the one runner on that machine that serves machine
 * tools claims it, answers it and sends the answer with its next claim. Where
 * the server offers it, the machine keeps one connection open instead, and
 * calls and answers travel over it without waiting for a poll.
 *
 * Each tool is a handler in `machineToolHandlers`. A handler runs a fixed
 * argument list as an asynchronous child process with a deadline, never a
 * shell. Files and history are read from Git objects of the runner's own
 * source checkout, never from a working folder. Every answer is masked for
 * secret shapes and cut to the stored limit.
 *
 * A machine whose saved runner settings say `machineWriteMode: "allow"` also
 * lists and answers the write tools of `lane-machine-workspaces.ts`. The
 * setting is read from the file on this machine only; nothing sent to the
 * runner can change it.
 */

export const MACHINE_TOOL_CLAIM = "machines.claim_machine_tool_calls";
/** How often a runner asks for calls, and how often after one arrived. */
export const MACHINE_TOOL_IDLE_MS = 10_000;
export const MACHINE_TOOL_ACTIVE_MS = 2_000;
const ACTIVE_WINDOW_MS = 120_000;
/** How long it stops asking after the server said it has no such tool. */
export const MACHINE_TOOL_UNAVAILABLE_MS = 3_600_000;
export const MACHINE_TOOL_FAILURE_LOG_MS = 60_000;
/**
 * With a connection open, calls arrive over it. The machine still asks once a
 * minute, which picks up a call the server could not push.
 */
export const MACHINE_TOOL_CONNECTED_MS = 60_000;
export const MACHINE_CONNECTION_PING_MS = 30_000;
/** This many pings in a row without an answer mean the connection is dead. */
const MACHINE_CONNECTION_MISSED_PINGS = 3;
const MACHINE_CONNECTION_RETRY_MAX_MS = 60_000;
const FILE_LINE_LIMIT = 400;
const LINE_LIMIT = 300;
const FETCH_INTERVAL_MS = 60_000;
const LOG_WINDOW_MS = 15 * 60_000;
/**
 * How long a receipt without an agent process still counts as a run being
 * started: preparation is a few gateway reads of at most five minutes each.
 */
const START_WINDOW_MS = 15 * 60_000;
const LOG_TAIL_BYTES = 256 * 1024;
/**
 * The runner's own copy of main. A ref of its own, so refreshing it never
 * contends with the fetch that prepares a run's checkout.
 */
const MAIN_REF = "refs/tedix/machine-tools/main";
const FAILURE_EVENTS = [
	"lease-expired",
	"heartbeat-failed",
	"skipped-or-failed",
	"run-steps-failed",
	"admissions-held",
	"restart-held",
];
const FAILURE_LINE = /##\[error\]|FAIL|error TS|AssertionError/;
const CI_RUN_FIELDS =
	"databaseId,workflowName,displayTitle,status,conclusion,headSha,headBranch,event,createdAt,url";

export interface MachineToolsIdentity {
	machineName: string;
	/** The tools this machine accepts; empty when no saved runner serves them. */
	machineTools: MachineToolName[];
	/** True when the owner switched the write tools on for this machine. */
	write: boolean;
	/** The saved runner that serves machine tools, when one does. */
	serving?: { key: string; workspace: string; organization: string };
}

/**
 * Who this machine is to a tedi, from the saved runner settings. Machine
 * tools are served under one runner's settings and sign-in, by a process of
 * their own: the codex runner's when one is enabled, else the first enabled
 * runner's in the saved list.
 */
export function machineToolsIdentity(
	env: NodeJS.ProcessEnv,
	duties?: RunnerDuty[],
): MachineToolsIdentity {
	let saved = duties;
	if (!saved)
		try {
			saved = readRunnerDuties(env);
		} catch {
			saved = [];
		}
	const enabled = saved.filter((duty) => duty.enabled);
	const duty =
		enabled.find((entry) => entry.executor === "codex") ?? enabled[0];
	const name =
		duty?.machineName ??
		enabled.find((entry) => entry.machineName)?.machineName;
	return {
		machineName:
			(name ?? hostname().split(".")[0] ?? "").trim().slice(0, 100) ||
			"machine",
		machineTools: duty
			? [
					...MACHINE_READ_TOOL_NAMES,
					...(duty.machineWriteMode === "allow"
						? [...MACHINE_HOME_TOOL_NAMES, ...MACHINE_WRITE_TOOL_NAMES]
						: []),
				]
			: [],
		write: duty?.machineWriteMode === "allow",
		...(duty
			? {
					serving: {
						key: runnerKey(duty),
						workspace: duty.workspace,
						organization: duty.organization,
					},
				}
			: {}),
	};
}

/** Cuts an answer to the stored limit and says so when it did. */
function bound(text: string): string {
	if (text.length <= MACHINE_TOOL_RESULT_MAX_CHARS) return text;
	const note = `\n[cut: this answer had ${text.length} characters; narrow the request to see the rest]`;
	return `${text.slice(0, MACHINE_TOOL_RESULT_MAX_CHARS - note.length)}${note}`;
}

type CommandResult = Awaited<ReturnType<typeof laneCommand>>;
export type MachineToolHandler = (input: MachineToolInput) => Promise<string>;

function failure(what: string, result: CommandResult): Error {
	if (result.error?.code === "ETIMEDOUT")
		return new Error(`${what} did not finish in time`);
	if (result.error?.code === "ENOENT")
		return new Error(`${what} needs a program this machine does not have`);
	return new Error(
		`${what} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 400)}`,
	);
}

const overflowed = (result: CommandResult) =>
	result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const readJson = async (path: string) =>
	parseJson(await readFile(path, "utf8").catch(() => ""));

async function readTail(path: string): Promise<string> {
	const file = await open(path, "r").catch(() => undefined);
	if (!file) return "";
	try {
		const { size } = await file.stat();
		const length = Math.min(size, LOG_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally {
		await file.close();
	}
}

/** The handler of every machine tool, for one runner's source checkout. */
export function machineToolHandlers(options: {
	/** The runner's own source checkout of the connected repository. */
	checkout: string;
	/** The Tedix settings folder that holds `dispatchers/`. */
	configDir: string;
	organization?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * Also answer the write tools and read the owner's home folder; only for
	 * `machineWriteMode: "allow"`.
	 */
	write?: boolean;
	/** The owner's home folder. */
	home?: string;
}): Record<(typeof MACHINE_READ_TOOL_NAMES)[number], MachineToolHandler> &
	Partial<Record<MachineToolName, MachineToolHandler>> {
	const { checkout } = options;
	const base = laneChildEnv(options.env ?? process.env);
	const gitEnv = {
		...base,
		GIT_LITERAL_PATHSPECS: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
	};
	const ghEnv = { ...base, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
	const git = (
		args: string[],
		timeout = 20_000,
		maxBuffer = 16 * 1024 * 1024,
	) =>
		laneCommand("git", ["-C", checkout, ...args], {
			timeout,
			maxBuffer,
			env: gitEnv,
		});
	const gh = (args: string[], timeout = 30_000) =>
		laneCommand("gh", args, {
			cwd: checkout,
			timeout,
			maxBuffer: 64 * 1024 * 1024,
			env: ghEnv,
		});

	let fetchedAt = Number.NEGATIVE_INFINITY;
	let fetching: Promise<unknown> | undefined;
	/** The commit main points at, refreshed at most once a minute. */
	async function mainCommit(): Promise<string> {
		if (Date.now() - fetchedAt >= FETCH_INTERVAL_MS && !fetching) {
			fetchedAt = Date.now();
			fetching = git(
				["fetch", "--no-tags", "origin", `+refs/heads/main:${MAIN_REF}`],
				60_000,
			).finally(() => {
				fetching = undefined;
			});
		}
		await fetching;
		// A failed refresh leaves the last copy; before the first, the run fetch's.
		for (const ref of [MAIN_REF, "refs/remotes/origin/main"]) {
			const found = await git([
				"rev-parse",
				"--verify",
				"--quiet",
				`${ref}^{commit}`,
			]);
			if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
		}
		throw new Error("This machine's checkout has no copy of main yet");
	}

	let repository: string | undefined;
	/** `owner/name` of the checkout's `origin` remote. */
	async function repositoryName(): Promise<string> {
		if (repository) return repository;
		const remote = await git(["remote", "get-url", "origin"]);
		const match =
			/github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
				remote.stdout.trim(),
			);
		if (remote.status !== 0 || !match)
			throw new Error("The checkout's origin is not a repository CI can read");
		repository = `${match[1]}/${match[2]}`;
		return repository;
	}

	async function runnerSection(directory: string): Promise<string> {
		const source = await readJson(join(directory, "health-source.json"));
		if (!isRecord(source) || typeof source.executor !== "string") return "";
		// The newest receipt of each Work Item says where its run stands.
		const latest = new Map<string, { version: number; file: string }>();
		for (const file of await readdir(directory).catch(() => [] as string[])) {
			const match = /^([0-9a-f-]{36})-(\d+)\.json$/.exec(file);
			if (match && (latest.get(match[1]!)?.version ?? -1) < Number(match[2]))
				latest.set(match[1]!, { version: Number(match[2]), file });
		}
		const runnerAlive = typeof source.pid === "number" && alive(source.pid);
		const live: Array<{
			id: string;
			phase: string;
			by: string;
			pid?: number;
			minutes?: number;
		}> = [];
		const held: string[] = [];
		const entries = [...latest];
		for (let index = 0; index < entries.length; index += 24)
			await Promise.all(
				entries.slice(index, index + 24).map(async ([id, { file }]) => {
					const row = await readJson(join(directory, file));
					if (!isRecord(row)) return;
					const phase = String(row.phase);
					const pid = typeof row.pid === "number" ? row.pid : undefined;
					const by = [row.executorKey ?? source.executor, row.model]
						.filter((part) => typeof part === "string")
						.join(" ");
					// A receipt with no agent process is a run only while its runner
					// is still starting it; one left by a stopped runner or a failed
					// start stays on disk in the same phase.
					const age =
						pid === undefined &&
						runnerAlive &&
						(phase === "settling" ||
							(["preparing", "admitted"].includes(phase) &&
								row.outcome === undefined))
							? Date.now() -
								((await stat(join(directory, file)).catch(() => undefined))
									?.mtimeMs ?? 0)
							: undefined;
					if (
						pid !== undefined &&
						["preparing", "admitted", "running", "settling"].includes(phase) &&
						alive(pid)
					)
						live.push({ id, phase, by, pid });
					else if (age !== undefined && age <= START_WINDOW_MS)
						live.push({ id, phase, by, minutes: Math.floor(age / 60_000) });
					else if (row.held === true)
						held.push(
							`${id}: ${typeof row.note === "string" ? row.note.replace(/\s+/g, " ").slice(0, 200) : "no reason recorded"}`,
						);
				}),
			);
		// Minutes each agent process has run, from one `ps` call.
		const minutes = new Map<number, number>();
		const pids = live.flatMap((entry) => entry.pid ?? []);
		if (pids.length) {
			const listed = await laneCommand(
				"ps",
				["-o", "pid=,etime=", "-p", pids.join(",")],
				{ timeout: 10_000, env: base },
			);
			for (const line of listed.stdout.split("\n")) {
				const match = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):\d+\s*$/.exec(
					line,
				);
				if (match)
					minutes.set(
						Number(match[1]),
						Number(match[2] ?? 0) * 1440 +
							Number(match[3] ?? 0) * 60 +
							Number(match[4]),
					);
			}
		}
		const events = new Map<string, { count: number; reason: string }>();
		for (const line of (
			await readTail(join(directory, "dispatcher.log"))
		).split("\n")) {
			const row = parseJson(line);
			if (
				isRecord(row) &&
				typeof row.event === "string" &&
				FAILURE_EVENTS.includes(row.event) &&
				typeof row.at === "string" &&
				Date.now() - Date.parse(row.at) <= LOG_WINDOW_MS
			)
				events.set(row.event, {
					count: (events.get(row.event)?.count ?? 0) + 1,
					reason: String(row.reason ?? "")
						.replace(/\s+/g, " ")
						.slice(0, 200),
				});
		}
		return [
			`Runner ${source.executor} (CLI ${source.cliVersion ?? "unknown"}, ${runnerAlive ? "running" : "not running"})`,
			`  Live runs: ${live.length}`,
			...live.slice(0, 20).map(({ id, phase, by, pid, minutes: waited }) => {
				const spent = pid === undefined ? waited : minutes.get(pid);
				return `    ${id} ${phase}, ${by}${spent !== undefined ? `, ${spent} min` : ""}`;
			}),
			`  Held: ${held.length}`,
			...held.slice(0, 20).map((line) => `    ${line}`),
			`  Last 15 minutes: ${
				[...events]
					.map(
						([event, { count, reason }]) =>
							`${event} x${count} (latest: ${reason})`,
					)
					.join("; ") || "no failure events"
			}`,
		].join("\n");
	}

	const home = machineHome({
		home: options.home ?? homedir(),
		configDir: options.configDir,
	});
	const workspaces = machineWorkspaces({
		checkout,
		configDir: options.configDir,
		mainCommit,
		home: options.home ?? homedir(),
		env: options.env,
	});
	const numbered = (lines: string[], input: MachineToolInput) => {
		if (lines.at(-1) === "") lines.pop();
		const start = Number(input.startLine ?? 1);
		const end = Math.min(
			Number(input.endLine ?? Number.POSITIVE_INFINITY),
			start + FILE_LINE_LIMIT - 1,
			lines.length,
		);
		return `lines ${start}-${end} of ${lines.length}\n${lines
			.slice(start - 1, end)
			.map((line, index) => `${start + index}\t${line}`)
			.join("\n")}`;
	};

	return {
		...(options.write
			? {
					...workspaces.handlers,
					list_folder: (input: MachineToolInput) =>
						home.listFolder(String(input.path)),
				}
			: {}),
		async read_file(input) {
			const path = String(input.path);
			if (isMachineHomePath(path)) {
				if (!options.write)
					throw new Error(
						"This machine reads only its repository; its owner has not switched on the tools that reach further",
					);
				return `${path}, ${numbered((await home.readText(path)).split("\n"), input)}`;
			}
			if (input.workspace !== undefined) {
				// The file as the workspace has it now, committed or not.
				const text = await readFile(
					await workspaces.filePath(String(input.workspace), path),
					"utf8",
				).catch(() => {
					throw new Error(`No such file in the workspace: ${path}`);
				});
				if (text.includes("\0")) throw new Error(`${path} is not a text file`);
				return `${path} in workspace ${input.workspace}, ${numbered(text.split("\n"), input)}`;
			}
			const commit = await mainCommit();
			const listed = await git(["ls-tree", "-z", commit, "--", path]);
			if (listed.status !== 0) throw failure("Reading the file", listed);
			const entry = listed.stdout
				.split("\0")
				.map((line) => /^(\d+) (\w+) [0-9a-f]+\t([\s\S]*)$/.exec(line))
				.find((match) => match?.[3] === path);
			if (!entry) throw new Error(`No such file on main: ${path}`);
			// A link could point out of the checkout; it is never followed.
			if (entry[1] === "120000")
				throw new Error(`${path} is a link; links are not followed`);
			if (entry[2] !== "blob") throw new Error(`${path} is not a file`);
			const shown = await git(["show", `${commit}:${path}`]);
			if (shown.status !== 0) throw failure("Reading the file", shown);
			if (shown.stdout.includes("\0"))
				throw new Error(`${path} is not a text file`);
			return `${path} at ${commit.slice(0, 9)}, ${numbered(shown.stdout.split("\n"), input)}`;
		},

		async search_code(input) {
			// A workspace is searched as its files are now, new files included.
			const folder =
				input.workspace === undefined
					? undefined
					: await workspaces.folder(String(input.workspace));
			const commit = folder ? "" : await mainCommit();
			const max = Number(input.maxResults ?? 50);
			const grep = (mode: "-E" | "-F") =>
				laneCommand(
					"git",
					[
						"-C",
						folder ?? checkout,
						"grep",
						"-n",
						"-I",
						"--no-color",
						...(folder ? ["--untracked"] : []),
						mode,
						"-e",
						String(input.pattern),
						...(folder ? [] : [commit]),
						"--",
						...(input.pathPrefix === undefined
							? []
							: [String(input.pathPrefix)]),
					],
					{ timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: gitEnv },
				);
			let found = await grep("-E");
			// A pattern that is not a valid expression is searched as plain text.
			if (!found.error && (found.status ?? 2) > 1) found = await grep("-F");
			if (found.status === 1 && !found.stdout) return "No matches";
			if (found.status !== 0 && !overflowed(found))
				throw failure("Searching the code", found);
			const lines = found.stdout.split("\n").filter(Boolean);
			const shown = lines.slice(0, max).map((line) => {
				const from = folder ? 0 : commit.length + 1;
				return line.slice(from, from + LINE_LIMIT);
			});
			return `${shown.join("\n")}${lines.length > max || overflowed(found) ? `\n[showing the first ${shown.length} matches; there are more]` : ""}`;
		},

		async list_commits(input) {
			const log = await git([
				"log",
				"--no-color",
				"-n",
				String(input.limit ?? 20),
				"--format=%h %cI %s",
				await mainCommit(),
				"--",
				...(input.path === undefined ? [] : [String(input.path)]),
			]);
			if (log.status !== 0) throw failure("Listing commits", log);
			return log.stdout.trim() || "No commits";
		},

		async read_commit(input) {
			await mainCommit();
			const shown = await git(
				[
					"show",
					"--no-color",
					"--no-ext-diff",
					"--no-textconv",
					"--stat",
					"--patch",
					"--format=commit %H%nDate: %cI%n%n%B",
					`${String(input.sha).toLowerCase()}^{commit}`,
					"--",
				],
				20_000,
				4 * 1024 * 1024,
			);
			if (shown.status !== 0 && !overflowed(shown))
				throw failure("Reading the commit", shown);
			return shown.stdout;
		},

		async read_ci_runs(input) {
			const repo = await repositoryName();
			let selector = ["--branch", "main"];
			if (input.sha !== undefined) {
				await mainCommit();
				// CI is asked by full commit id.
				const full = await git([
					"rev-parse",
					"--verify",
					"--quiet",
					`${String(input.sha).toLowerCase()}^{commit}`,
				]);
				selector = [
					"--commit",
					full.status === 0 ? full.stdout.trim() : String(input.sha),
				];
			}
			const listed = await gh([
				"run",
				"list",
				"--repo",
				repo,
				"--limit",
				String(input.limit ?? 5),
				"--json",
				CI_RUN_FIELDS,
				...selector,
			]);
			if (listed.status !== 0) throw failure("Reading CI runs", listed);
			const runs: unknown = parseJson(listed.stdout);
			if (!Array.isArray(runs) || !runs.length) return "No CI runs";
			// The job log tool needs a job id, so a failed run names its failed jobs.
			const rows = await Promise.all(
				runs.filter(isRecord).map(async (row) => {
					if (row.conclusion !== "failure") return row;
					const viewed = parseJson(
						(
							await gh([
								"run",
								"view",
								String(row.databaseId),
								"--repo",
								repo,
								"--json",
								"jobs",
							])
						).stdout,
					);
					const jobs = isRecord(viewed) ? viewed.jobs : undefined;
					return {
						...row,
						failedJobs: (Array.isArray(jobs) ? jobs : []).flatMap((job) =>
							isRecord(job) && job.conclusion === "failure"
								? [{ jobId: String(job.databaseId), name: job.name }]
								: [],
						),
					};
				}),
			);
			return rows.map((row) => JSON.stringify(row)).join("\n");
		},

		async read_ci_job_log(input) {
			const args = [
				"api",
				`repos/${await repositoryName()}/actions/jobs/${input.jobId}/logs`,
			];
			// Newer versions hold back a log with colour codes unless told
			// otherwise; older ones do not know the option.
			let log = await gh([...args, "--allow-escape-sequences"], 45_000);
			if (log.status !== 0 && /unknown flag/i.test(log.stderr))
				log = await gh(args, 45_000);
			if (log.status !== 0 && !overflowed(log))
				throw failure("Reading the job log", log);
			const lines = log.stdout
				.split("\n")
				.map((line) =>
					line
						// oxlint-disable-next-line no-control-regex -- strips colour codes
						.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
						.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /, "")
						.trimEnd(),
				)
				.filter(Boolean);
			if (typeof input.contains === "string") {
				const needle = input.contains;
				const matches = lines.filter((line) => line.includes(needle));
				const shown = matches.slice(-30);
				const extent = overflowed(log) ? "partial log" : "log";
				return [
					`${matches.length} matching lines in the ${extent}; showing the last ${shown.length}`,
					...shown.map((line) => {
						const start = Math.max(0, line.indexOf(needle) - 120);
						return line.slice(start, start + 500);
					}),
				].join("\n");
			}
			const failures = lines.filter((line) => FAILURE_LINE.test(line));
			const shown = failures.length ? failures : lines.slice(-30);
			return `${
				failures.length
					? `${failures.length} failure lines of ${lines.length} log lines`
					: `No failure lines in ${lines.length} log lines; the last ${shown.length}:`
			}\n${shown.map((line) => line.slice(0, 500)).join("\n")}`;
		},

		async dispatch_work_item({ workItemId, projectId, executor }) {
			const duties = runnersForWork(
				readRunnerDuties(options.env ?? process.env),
				options.organization!,
				String(projectId),
			);
			const wantedExecutors =
				executor === "any-local"
					? [
							"any-local",
							...duties
								.filter((duty) => duty.coordinated)
								.map((duty) => duty.executor),
						]
					: [executor, "any-local"];
			for (const wanted of wantedExecutors) {
				for (const duty of duties) {
					if (duty.executor !== wanted) continue;
					const directory = join(
						options.configDir,
						"dispatchers",
						runnerKey(duty),
					);
					try {
						await writeFile(
							join(dispatchRequestsDirectory(directory), String(workItemId)),
							"",
							{ flag: "wx", mode: 0o600 },
						);
						return "Dispatcher notified";
					} catch (error) {
						const code = (error as NodeJS.ErrnoException).code;
						if (code === "EEXIST") return "Dispatcher notified";
						if (code !== "ENOENT") throw error;
					}
				}
			}
			throw new Error("No matching dispatcher is listening on this machine");
		},

		async read_runner_state() {
			const root = join(options.configDir, "dispatchers");
			const names = await readdir(root).catch(() => [] as string[]);
			const sections = await Promise.all(
				names.sort().map((name) => runnerSection(join(root, name))),
			);
			return sections.filter(Boolean).join("\n\n") || "No runners here";
		},
	};
}

/** Answers one call with its handler; never throws. */
export async function answerMachineToolCall(
	handlers: Partial<Record<string, MachineToolHandler>>,
	tool: string,
	input: unknown,
): Promise<{ ok: true; result: string } | { ok: false; error: string }> {
	try {
		const handler = handlers[tool];
		const known = MACHINE_TOOL_NAMES.find((name) => name === tool);
		if (!handler || !known) throw new Error(`This machine has no ${tool}`);
		const parsed = parseMachineToolInput(known, input);
		if (!parsed.ok) throw new Error(parsed.message);
		return { ok: true, result: bound(scrubText(await handler(parsed.input))) };
	} catch (error) {
		return {
			ok: false,
			error: scrubText(
				error instanceof Error ? error.message : String(error),
			).slice(0, 1_000),
		};
	}
}

export interface MachineToolClaimInput {
	reporterId: string;
	machineName: string;
	limit: number;
	results?: Array<{
		callId: string;
		ok: boolean;
		result?: string;
		error?: string;
	}>;
}

/**
 * Asks for calls in-process under the owner's stored sign-in, the identity
 * that also reports this machine's runner health. A claim has no run, so it
 * cannot use a run's connection.
 */
export function createMachineToolClaimer(scope: string[]) {
	let context: NativeToolContext | undefined;
	return async (input: MachineToolClaimInput): Promise<unknown> => {
		if (!context) {
			const { options } = parseOptions([...scope, "work"]);
			const workspace = options.workspace || getCurrentWorkspace() || "default";
			const stored = await resolveStoredLoginAuth(workspace, {
				consentPrompt: false,
			});
			const auth = stored.auth;
			if (!auth)
				throw new Error(
					stored.loginError ?? "Machine tools need an existing owner login",
				);
			const url = options.urlExplicit
				? options.url
				: (auth.mcpUrl ?? options.url);
			const target = resolveOrganizationTarget({
				url,
				command: "work",
				workspace,
				organization: options.organization,
				accessToken:
					(await auth.oauthProvider?.tokens())?.access_token ??
					auth.headers.Authorization?.replace(/^Bearer\s+/i, ""),
			});
			context = {
				client: new TedixHomeClient({
					url,
					headers: { ...auth.headers, ...target.headers },
					oauthProvider: auth.oauthProvider,
					discoveryCache: fileDiscoveryCache(),
					timeoutMs: 20_000,
				}),
				nativeCacheScope: JSON.stringify([target.workspace, auth.source]),
				workspace: target.workspace,
				mcpUrl: url,
				bootstrapCache: fileNativeBootstrapCache(),
			};
		}
		return callConfiguredNativeTool(
			context,
			MACHINE_TOOL_CLAIM,
			input as unknown as Record<string, unknown>,
		);
	};
}

/** The part of a WebSocket the machine's connection uses. */
export interface MachineSocket {
	send(text: string): void;
	close(): void;
	addEventListener(
		type: "open" | "message" | "close" | "error",
		listener: (event: { data?: unknown }) => void,
	): void;
}

/** Opens the connection with the ticket as the offered protocol. */
export const openMachineSocket = (url: string, ticket: string): MachineSocket =>
	new WebSocket(url, [`bearer-${ticket}`]) as unknown as MachineSocket;

type MachineToolOutcome = NonNullable<MachineToolClaimInput["results"]>[number];

/**
 * The claim-and-answer loop. `cycle` does one round and returns how long to
 * wait before the next; nothing it does can fail a run.
 *
 * When a claim's answer offers a connection, the loop opens it: calls then
 * arrive over the socket and are answered on it. While no connection is open
 * (the server offers none, or it dropped) the loop polls as it always has,
 * and each poll that offers a connection is a chance to open it again.
 */
export function createMachineToolsLoop(options: {
	reporterId: string;
	machineName: string;
	claim: (input: MachineToolClaimInput) => Promise<unknown>;
	handlers: Partial<Record<string, MachineToolHandler>>;
	/** Tool name and outcome only: never an input or an answer. */
	log: (event: string, reason: string) => void;
	/** Opens the connection; without it the loop only polls. */
	openSocket?: (url: string, ticket: string) => MachineSocket;
	/** Called when the connection closes, so the next poll need not wait. */
	onConnectionClosed?: () => void;
}) {
	const running = new Set<Promise<void>>();
	let finished: MachineToolOutcome[] = [];
	let lastCallAt = Number.NEGATIVE_INFINITY;
	let failures = 0;
	let failureLoggedAt = Number.NEGATIVE_INFINITY;
	/** The socket being opened or open, and whether it is open. */
	let socket: MachineSocket | undefined;
	let connected = false;
	/** Answers sent on the socket that the server has not confirmed yet. */
	const unconfirmed = new Map<string, MachineToolOutcome>();
	let dialFailures = 0;
	let nextDialAt = Number.NEGATIVE_INFINITY;

	function answer(call: Record<string, unknown>, callId: string) {
		lastCallAt = Date.now();
		const work = answerMachineToolCall(
			options.handlers,
			String(call.tool),
			call.input,
		).then((outcome) => {
			const result = { callId, ...outcome };
			if (connected && socket) {
				unconfirmed.set(callId, result);
				try {
					socket.send(JSON.stringify(result));
				} catch {
					// The close that follows moves it to the next claim.
				}
			} else finished.push(result);
			options.log(
				"machine-tool-answered",
				`${String(call.tool).slice(0, 40)} ${outcome.ok ? "ok" : "failed"}`,
			);
			running.delete(work);
		});
		running.add(work);
	}

	function dial(url: string, ticket: string) {
		let opened: MachineSocket;
		try {
			opened = options.openSocket!(url, ticket);
		} catch {
			dialFailed();
			return;
		}
		socket = opened;
		let unansweredPings = 0;
		let pinging: ReturnType<typeof setInterval> | undefined;
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(pinging);
			try {
				opened.close();
			} catch {
				// Already closed.
			}
			if (socket !== opened) return;
			socket = undefined;
			// An answer the server never confirmed goes with the next claim.
			finished.push(...unconfirmed.values());
			unconfirmed.clear();
			dialFailed();
			if (!connected) return;
			connected = false;
			options.log("machine-connection-closed", "polling");
			options.onConnectionClosed?.();
		};
		opened.addEventListener("open", () => {
			connected = true;
			dialFailures = 0;
			options.log("machine-connection-open", options.machineName);
			pinging = setInterval(() => {
				// Counted in pings, not seconds, so a machine that slept is not
				// taken for a dead connection before it had a chance to answer.
				if (unansweredPings >= MACHINE_CONNECTION_MISSED_PINGS) return close();
				unansweredPings += 1;
				try {
					opened.send("ping");
				} catch {
					close();
				}
			}, MACHINE_CONNECTION_PING_MS);
		});
		opened.addEventListener("message", ({ data }) => {
			if (data === "pong") {
				unansweredPings = 0;
				return;
			}
			const message = typeof data === "string" ? parseJson(data) : undefined;
			if (!isRecord(message)) return;
			if (typeof message.answered === "string")
				unconfirmed.delete(message.answered);
			else if (typeof message.callId === "string")
				answer(message, message.callId);
		});
		opened.addEventListener("close", close);
		opened.addEventListener("error", close);
	}

	/** Waits longer after each failure, at a random point of the wait. */
	function dialFailed() {
		dialFailures += 1;
		nextDialAt =
			Date.now() +
			Math.min(
				MACHINE_CONNECTION_RETRY_MAX_MS,
				1_000 * 2 ** Math.min(dialFailures - 1, 10),
			) *
				(0.5 + Math.random() / 2);
	}

	async function cycle(): Promise<number> {
		const sending = finished.slice(0, 20);
		let value: unknown;
		try {
			value = await options.claim({
				reporterId: options.reporterId,
				machineName: options.machineName,
				limit: 5,
				...(sending.length ? { results: sending } : {}),
			});
		} catch (error) {
			const message = scrubText(
				error instanceof Error ? error.message : String(error),
			).slice(0, 300);
			if (runStepToolMissing(message)) {
				options.log("machine-tools-unavailable", message);
				return MACHINE_TOOL_UNAVAILABLE_MS;
			}
			// Said again each minute, so a long outage is not one old line.
			if (Date.now() - failureLoggedAt >= MACHINE_TOOL_FAILURE_LOG_MS) {
				failureLoggedAt = Date.now();
				options.log("machine-tools-failed", message);
			}
			failures += 1;
			return MACHINE_TOOL_IDLE_MS;
		}
		if (failures)
			options.log(
				"machine-tools-recovered",
				`after ${failures} failed ${failures === 1 ? "claim" : "claims"}`,
			);
		failures = 0;
		failureLoggedAt = Number.NEGATIVE_INFINITY;
		finished = finished.filter((result) => !sending.includes(result));
		for (const call of isRecord(value) && Array.isArray(value.calls)
			? value.calls
			: []) {
			if (!isRecord(call) || typeof call.callId !== "string") continue;
			answer(call, call.callId);
		}
		const offered = isRecord(value) ? value.connection : undefined;
		if (
			options.openSocket &&
			!socket &&
			Date.now() >= nextDialAt &&
			isRecord(offered) &&
			typeof offered.url === "string" &&
			typeof offered.ticket === "string"
		)
			dial(offered.url, offered.ticket);
		if (connected) return MACHINE_TOOL_CONNECTED_MS;
		return Date.now() - lastCallAt < ACTIVE_WINDOW_MS
			? MACHINE_TOOL_ACTIVE_MS
			: MACHINE_TOOL_IDLE_MS;
	}

	return {
		cycle,
		inFlight: () => Promise.all(running),
		/** True when no call is being answered and no answer waits to be sent. */
		idle: () =>
			running.size === 0 && finished.length === 0 && unconfirmed.size === 0,
		/** Closes the connection; the loop is not used afterwards. */
		close: () => socket?.close(),
	};
}

/**
 * `tedix lane serve --machine-tools-only`: answers machine tool calls in a
 * process of its own, so a runner busy with agent runs cannot delay them. The
 * supervisor keeps one per machine, started with the arguments of the runner
 * the saved settings pick; a second one waits for the first to leave. It
 * leaves, to be started again, when those settings change or a newer CLI is
 * installed, once no answer is in progress or unsent.
 */
export async function serveMachineTools(
	serve: { scope: string[]; repo: string },
	installedVersion: () => string | undefined | Promise<string | undefined>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const identity = machineToolsIdentity(env);
	const saved = JSON.stringify(identity);
	const scoped = (name: string) => serve.scope[serve.scope.indexOf(name) + 1];
	if (
		!identity.serving ||
		identity.serving.organization !== scoped("--organization") ||
		identity.serving.workspace !== scoped("--workspace")
	) {
		process.stderr.write(
			"Machine tools are served for the runner the saved settings pick; these arguments are not that runner's\n",
		);
		return 1;
	}
	const configDir = env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix");
	const log = (event: string, reason: string) =>
		process.stderr.write(
			`${JSON.stringify({ at: new Date().toISOString(), event, reason })}\n`,
		);
	const loop = createMachineToolsLoop({
		reporterId: dispatcherReporterId(env),
		machineName: identity.machineName,
		claim: createMachineToolClaimer(serve.scope),
		handlers: machineToolHandlers({
			checkout: serve.repo,
			configDir,
			organization: identity.serving.organization,
			env,
			write: identity.write,
		}),
		log,
		openSocket: openMachineSocket,
		onConnectionClosed: () => wake(),
	});
	let stopping = false;
	let wake = () => {};
	const stop = () => {
		stopping = true;
		wake();
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	const lock = beginFileLock(join(configDir, "machine-tools", "lock"));
	try {
		log("machine-tools-serving", identity.machineName);
		while (!stopping) {
			if (
				loop.idle() &&
				(JSON.stringify(machineToolsIdentity(env)) !== saved ||
					(await installedVersion()))
			)
				return RUNNER_UPDATE_EXIT_CODE;
			const delay = lock.ready()
				? await loop.cycle().catch(() => MACHINE_TOOL_IDLE_MS)
				: MACHINE_TOOL_ACTIVE_MS;
			if (stopping) break;
			await new Promise<void>((done) => {
				const timer = setTimeout(done, delay);
				wake = () => {
					clearTimeout(timer);
					done();
				};
			});
		}
		return 0;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
		loop.close();
		lock.release();
	}
}
