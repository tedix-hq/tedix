import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
	MACHINE_COMMAND_DEFAULT_TIMEOUT_SECONDS,
	type MACHINE_WRITE_TOOL_NAMES,
	type MachineToolInput,
} from "@tedix/api-contract/schemas/machines";
import { laneChildEnv } from "./lane-child-env";
import { laneCommand } from "./lane-command";
import {
	refusedMachineCommand,
	refusedMachinePath,
} from "./lane-machine-refused";

/**
 * Machine workspaces: a tedi's own checkout of the repository on a machine,
 * where it may write and edit files and run commands. Each is a Git worktree
 * of the runner's source checkout under `machine-workspaces/<id>/repo` in the
 * Tedix settings folder, never a person's working folder and never the source
 * checkout itself.
 *
 * These handlers exist only on a machine whose saved runner settings say
 * `machineWriteMode: "allow"`. File paths stay inside the workspace. A command
 * runs through the login shell with the runner's own environment, as an agent
 * run does; `lane-machine-refused.ts` lists what is refused all the same.
 */

type WriteToolName = (typeof MACHINE_WRITE_TOOL_NAMES)[number];
type Handler = (input: MachineToolInput) => Promise<string>;

const IDLE_MS = 24 * 60 * 60_000;
const KILL_GRACE_MS = 2_000;
/** Kept from each end of a long output; together under the stored limit. */
const OUTPUT_HEAD_CHARS = 9_000;
const OUTPUT_TAIL_CHARS = 9_000;
/** Where the commits of a removed workspace stay reachable. */
const RESCUE_REF = "refs/tedix/machine-workspaces";

export interface MachineWorkspaces {
	handlers: Record<WriteToolName, Handler>;
	/** The folder of an open workspace; throws when there is none. */
	folder(id: string): Promise<string>;
	/** The path of a file inside a workspace; refuses a link that leaves it. */
	filePath(id: string, path: string): Promise<string>;
}

export function machineWorkspaces(options: {
	/** The runner's own source checkout of the connected repository. */
	checkout: string;
	/** The Tedix settings folder. */
	configDir: string;
	/** The commit a new workspace starts from when none is named. */
	mainCommit: () => Promise<string>;
	env?: NodeJS.ProcessEnv;
}): MachineWorkspaces {
	const root = join(options.configDir, "machine-workspaces");
	const env = laneChildEnv(options.env ?? process.env);
	const git = (args: string[], timeout = 30_000) =>
		laneCommand("git", ["-C", options.checkout, ...args], {
			timeout,
			env: { ...env, GIT_TERMINAL_PROMPT: "0" },
		});

	async function folder(id: string): Promise<string> {
		const repo = join(root, id, "repo");
		if (!(await stat(repo).catch(() => undefined))?.isDirectory())
			throw new Error(
				`No open workspace ${id} on this machine; open one with open_workspace`,
			);
		// The folder's time says when the workspace was last used.
		const now = new Date();
		await utimes(join(root, id), now, now).catch(() => {});
		return repo;
	}

	async function filePath(id: string, path: string): Promise<string> {
		const repo = await realpath(await folder(id));
		const target = join(repo, path);
		// The nearest folder that exists must still be inside the workspace.
		let existing = target;
		while (!(await lstat(existing).catch(() => undefined)))
			existing = dirname(existing);
		const resolved = await realpath(existing);
		if (resolved !== repo && !resolved.startsWith(repo + sep))
			throw new Error(`${path} leaves the workspace through a link`);
		return target;
	}

	/** Keeps commits that exist nowhere else, then removes the checkout. */
	async function remove(id: string): Promise<string> {
		const repo = join(root, id, "repo");
		let kept = "";
		const head = await laneCommand("git", ["-C", repo, "rev-parse", "HEAD"], {
			timeout: 10_000,
			env,
		});
		const commit = head.stdout.trim();
		if (head.status === 0 && commit) {
			const onMain = await git([
				"merge-base",
				"--is-ancestor",
				commit,
				await options.mainCommit().catch(() => "refs/remotes/origin/main"),
			]);
			if (onMain.status !== 0) {
				await git(["update-ref", `${RESCUE_REF}/${id}`, commit]);
				kept = ` Its commits are kept as ${RESCUE_REF}/${id}.`;
			}
		}
		await git(["worktree", "remove", "--force", repo], 60_000);
		await rm(join(root, id), { recursive: true, force: true });
		await git(["worktree", "prune"]);
		return kept;
	}

	async function removeIdle(): Promise<void> {
		for (const id of await readdir(root).catch(() => [] as string[])) {
			const used = await stat(join(root, id)).catch(() => undefined);
			if (used && Date.now() - used.mtimeMs > IDLE_MS)
				await remove(id).catch(() => {});
		}
	}

	return {
		folder,
		filePath,
		handlers: {
			async open_workspace(input) {
				await removeIdle();
				const main = await options.mainCommit();
				let commit = main;
				if (input.base !== undefined) {
					const found = await git([
						"rev-parse",
						"--verify",
						"--quiet",
						`${String(input.base)}^{commit}`,
					]);
					if (found.status !== 0 || !found.stdout.trim())
						throw new Error(`This machine knows no commit ${input.base}`);
					commit = found.stdout.trim();
				}
				const id = `${input.name ?? "workspace"}-${randomBytes(4).toString("hex")}`;
				const repo = join(root, id, "repo");
				await mkdir(join(root, id), { recursive: true, mode: 0o700 });
				// A whole-repository checkout can take minutes.
				const added = await git(
					["worktree", "add", "--quiet", "--detach", repo, commit],
					10 * 60_000,
				);
				if (added.status !== 0) {
					await rm(join(root, id), { recursive: true, force: true });
					await git(["worktree", "prune"]);
					throw new Error(
						`The workspace was not created: ${(added.stderr || added.error?.message || "git worktree add failed").trim().slice(0, 300)}`,
					);
				}
				return `workspace: ${id}\nA checkout of the repository at commit ${commit.slice(0, 9)}, with no branch checked out. Give this workspace id to the other workspace tools. Dependencies are not installed.`;
			},

			async close_workspace(input) {
				const id = String(input.workspace);
				await folder(id);
				return `Closed workspace ${id}.${await remove(id)}`;
			},

			async write_file(input) {
				const path = String(input.path);
				const refused = refusedMachinePath(path);
				if (refused) throw new Error(`Refused: ${refused}`);
				const target = await filePath(String(input.workspace), path);
				const existing = await lstat(target).catch(() => undefined);
				if (existing?.isDirectory()) throw new Error(`${path} is a folder`);
				if (existing?.isSymbolicLink())
					throw new Error(`${path} is a link; links are not written through`);
				await mkdir(dirname(target), { recursive: true });
				const content = String(input.content);
				await writeFile(target, content, "utf8");
				return `${existing ? "Replaced" : "Created"} ${path} (${content.length} characters)`;
			},

			async edit_file(input) {
				const path = String(input.path);
				const refused = refusedMachinePath(path);
				if (refused) throw new Error(`Refused: ${refused}`);
				const target = await filePath(String(input.workspace), path);
				const existing = await lstat(target).catch(() => undefined);
				if (!existing?.isFile())
					throw new Error(
						existing ? `${path} is not a file` : `No such file: ${path}`,
					);
				const content = await readFile(target, "utf8");
				const oldText = String(input.oldText);
				const newText = String(input.newText);
				if (oldText === newText)
					throw new Error(
						"oldText and newText are the same; nothing to change",
					);
				const count = content.split(oldText).length - 1;
				if (count === 0)
					throw new Error(
						`oldText was not found in ${path}. ${
							oldText.trim() !== oldText && content.includes(oldText.trim())
								? "Spaces or line breaks at its start or end differ from the file."
								: content
											.replace(/\s+/g, " ")
											.includes(oldText.replace(/\s+/g, " ").trim())
									? "Line breaks or indentation differ from the file."
									: "Read the file again and copy the exact text."
						}`,
					);
				if (count > 1 && input.replaceAll !== true)
					throw new Error(
						`oldText occurs ${count} times in ${path}. Add surrounding text so it occurs once, or set replaceAll.`,
					);
				const index = content.indexOf(oldText);
				await writeFile(
					target,
					input.replaceAll === true
						? content.split(oldText).join(newText)
						: content.slice(0, index) +
								newText +
								content.slice(index + oldText.length),
					"utf8",
				);
				return `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${path}, the first at line ${content.slice(0, index).split("\n").length}`;
			},

			async run_command(input) {
				const command = String(input.command);
				const refused = refusedMachineCommand(command);
				if (refused) throw new Error(`Refused: ${refused}`);
				const cwd = await folder(String(input.workspace));
				const seconds = Number(
					input.timeoutSeconds ?? MACHINE_COMMAND_DEFAULT_TIMEOUT_SECONDS,
				);
				const ran = await runShellCommand(command, {
					cwd,
					env,
					timeoutMs: seconds * 1_000,
				});
				return `${
					ran.timedOut
						? `Stopped after ${seconds} seconds (the timeout)`
						: ran.exitCode === null
							? `Ended by signal ${ran.signal}`
							: `Exit code ${ran.exitCode}`
				}\n${ran.output || "(no output)"}`;
			},
		},
	};
}

/**
 * Runs one command line through the login shell in its own process group,
 * with standard output and error combined in arrival order. On the timeout the
 * whole group is asked to end and, two seconds later, killed. A long output
 * keeps its start and its end.
 */
export function runShellCommand(
	command: string,
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
		killGraceMs?: number;
	},
): Promise<{
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	output: string;
}> {
	return new Promise((resolve, reject) => {
		const named = options.env.SHELL ?? "";
		const shell = /\/(?:bash|zsh)$/.test(named)
			? named
			: process.platform === "darwin"
				? "/bin/zsh"
				: "/bin/bash";
		const child = spawn(shell, ["-lc", command], {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let head = "";
		let tail = "";
		let total = 0;
		const collect = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			total += text.length;
			const room = OUTPUT_HEAD_CHARS - head.length;
			head += text.slice(0, Math.max(room, 0));
			tail = (tail + text.slice(Math.max(room, 0))).slice(-OUTPUT_TAIL_CHARS);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const signalGroup = (signal: NodeJS.Signals) => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, signal);
			} catch {
				// The group already ended.
			}
		};
		let timedOut = false;
		let force: ReturnType<typeof setTimeout> | undefined;
		const deadline = setTimeout(() => {
			timedOut = true;
			signalGroup("SIGTERM");
			force = setTimeout(
				() => signalGroup("SIGKILL"),
				options.killGraceMs ?? KILL_GRACE_MS,
			);
		}, options.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(deadline);
			clearTimeout(force);
			reject(new Error(`The command could not start: ${error.message}`));
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(deadline);
			clearTimeout(force);
			const omitted = total - head.length - tail.length;
			resolve({
				exitCode,
				signal,
				timedOut,
				output:
					omitted > 0
						? `${head}\n[... ${omitted} characters left out ...]\n${tail}`
						: head + tail,
			});
		});
	});
}
