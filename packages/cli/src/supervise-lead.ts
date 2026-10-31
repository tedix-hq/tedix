import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ReadJson } from "./hooks/hook-io";
import { laneChildEnv } from "./lane-child-env";
import { beginFileLock } from "./local-file-lock";
import {
	alive,
	configDir,
	protectedResumeReason,
	resumeReceipt,
	supervisorLog,
} from "./supervise-drivers";

const text = z.string().trim().min(1);
const executorSchema = z.object({
	executor: z.enum(["devin", "codex", "claude-code", "opencode"]),
	session: text.regex(/^[a-zA-Z0-9_-]+$/),
});
const configSchema = z.object({
	enabled: z.literal(true),
	intervalMinutes: z.number().finite().positive().default(20),
	workspace: text,
	organization: text,
	cwd: text.refine(isAbsolute, "cwd must be absolute"),
	playbook: text,
	status: text,
	executors: z.array(executorSchema).min(1),
});
export type LeadConfig = z.infer<typeof configSchema>;
type Executor = z.infer<typeof executorSchema>;
export type LeadRun = (
	config: LeadConfig,
	executor: Executor,
	prompt: string,
	onSpawn: (pid: number) => void,
) => Promise<boolean>;

export function leadCommand(
	executor: Executor,
	input: string,
	output: string,
): { command: string; args: string[] } {
	const session = executor.session;
	switch (executor.executor) {
		case "devin":
			return {
				command: "devin",
				args: [
					"--cloud",
					"-r",
					session,
					"-p",
					"--prompt-file",
					input,
					"--export",
					output,
				],
			};
		case "codex":
			return {
				command: "codex",
				args: [
					"exec",
					"--skip-git-repo-check",
					"--json",
					"resume",
					session,
					"-",
				],
			};
		case "claude-code":
			return {
				command: "claude",
				args: [
					"-p",
					"--resume",
					session,
					"--output-format",
					"stream-json",
					"--verbose",
				],
			};
		case "opencode":
			return {
				command: "opencode",
				args: ["run", "--session", session, "--format", "json"],
			};
	}
}

/** Wait for process exit, not just a session-start receipt, before falling back. */
export function leadRunner(env: NodeJS.ProcessEnv): LeadRun {
	return async (config, executor, prompt, onSpawn) => {
		if (protectedResumeReason(config.cwd, env)) return false;
		const directory = join(configDir(env), "supervisor", "lead");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const input = join(directory, "prompt.txt");
		const output = join(directory, `${executor.executor}.jsonl`);
		writeFileSync(input, prompt, { mode: 0o600 });
		writeFileSync(output, "", { mode: 0o600 });
		const launch = leadCommand(executor, input, output);
		const fds = [
			openSync(input, "r"),
			openSync(
				executor.executor === "devin" ? `${output}.log` : output,
				"w",
				0o600,
			),
			openSync(join(directory, "stderr.log"), "a", 0o600),
		];
		let child;
		try {
			child = spawn(launch.command, launch.args, {
				cwd: config.cwd,
				env: laneChildEnv(env),
				detached: true,
				stdio: fds,
			});
		} finally {
			for (const fd of fds) closeSync(fd);
		}
		return await new Promise<boolean>((resolve) => {
			const stop = (signal: NodeJS.Signals) => {
				try {
					if (child.pid) process.kill(-child.pid, signal);
				} catch {
					/* Already exited. */
				}
			};
			let timedOut = false;
			let kill: ReturnType<typeof setTimeout> | undefined;
			const timer = setTimeout(() => {
				timedOut = true;
				stop("SIGTERM");
				kill = setTimeout(() => stop("SIGKILL"), 5000);
			}, 15 * 60_000);
			const clear = () => {
				clearTimeout(timer);
				if (kill) clearTimeout(kill);
			};
			child.once("error", () => {
				clear();
				resolve(false);
			});
			child.once("close", (code) => {
				clear();
				let receipt;
				try {
					const content = readFileSync(output, "utf8");
					receipt = resumeReceipt(content);
					if (
						content.split("\n").some((line) => {
							try {
								return JSON.parse(line).type === "turn.failed";
							} catch {
								return false;
							}
						})
					)
						receipt.failed = true;
				} catch {
					resolve(false);
					return;
				}
				resolve(
					!timedOut &&
						code === 0 &&
						!receipt.failed &&
						receipt.sessions.includes(executor.session) &&
						receipt.sessions.every((id) => id === executor.session),
				);
			});
			try {
				if (child.pid) onSpawn(child.pid);
			} catch {
				timedOut = true;
				stop("SIGKILL");
			}
		});
	};
}

/** An opt-in duty of the existing supervisor; receipts survive --once and restarts. */
export class LeadDuty {
	private running?: Promise<void>;
	failed = false;
	constructor(
		private readonly deps: {
			env: NodeJS.ProcessEnv;
			read: ReadJson;
			now?: () => number;
			log?: (line: string) => void;
			run?: LeadRun;
		},
	) {}
	private log(line: string) {
		(this.deps.log ?? ((line) => supervisorLog(this.deps.env, line)))(
			`Lead: ${line}`,
		);
	}
	private now() {
		return (this.deps.now ?? Date.now)();
	}

	async tick(wait = false): Promise<void> {
		if (!this.running) {
			this.running = this.pass()
				.catch(() => {
					this.failed = true;
					this.log("duty failed; inspect configuration and retained receipt");
				})
				.finally(() => {
					this.running = undefined;
				});
		}
		if (wait) await this.running;
	}

	private async pass(): Promise<void> {
		const root = configDir(this.deps.env);
		const path = join(root, "supervisor-lead.json");
		if (!existsSync(path)) return;
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (value.enabled === false) return;
		const config = configSchema.parse(value);
		const lock = beginFileLock(join(root, "supervisor", "lead-lock"));
		try {
			if (!lock.ready()) return;
			const statePath = join(root, "supervisor", "lead-state.json");
			const state = existsSync(statePath)
				? JSON.parse(readFileSync(statePath, "utf8"))
				: {};
			// A child can outlive a crashed supervisor. Never launch over it, even when overdue.
			if (Number.isSafeInteger(state.pid) && state.pid > 0 && alive(state.pid))
				return;
			const now = this.now();
			if (
				typeof state.startedAt === "number" &&
				now - state.startedAt < config.intervalMinutes * 60_000
			)
				return;
			const save = (pid: number | null) => {
				writeFileSync(
					`${statePath}.tmp`,
					JSON.stringify({ startedAt: now, pid }),
					{ mode: 0o600 },
				);
				renameSync(`${statePath}.tmp`, statePath);
			};
			save(null);
			this.failed = false;
			const prompt = `Run exactly one Lead pass. Read the Lead playbook at ${config.playbook} and the current status document at ${config.status}, using Tedix --workspace ${config.workspace} --organization ${config.organization}. Follow the playbook's judgement loop once and record the result in that status document and relevant Tedix Work comments. Re-read current Work and admission before execution; preserve dispatcher-owned Attempts. Do not create a scheduler, sleep for another pass, or change this duty's configuration. Human consent, MFA and required user presence remain with the human. Stop after this pass.`;
			for (const [index, executor] of config.executors.entries()) {
				this.log(
					`${index ? "fallback to" : "starting"} ${executor.executor} session ${executor.session}`,
				);
				let ok = false;
				try {
					ok = await (this.deps.run ?? leadRunner(this.deps.env))(
						config,
						executor,
						prompt,
						save,
					);
				} catch {
					this.log(`${executor.executor} launch or receipt failed`);
				}
				save(null);
				const reason = `${executor.executor} ${ok ? "pass finished" : "pass failed"}${
					index
						? ` after fallback from ${config.executors
								.slice(0, index)
								.map((e) => e.executor)
								.join(", ")}`
						: ""
				}`;
				this.log(reason);
				try {
					await this.deps.read(
						[
							"--workspace",
							config.workspace,
							"--organization",
							config.organization,
							"work",
							"dispatcher-health-record",
							"--input",
							JSON.stringify({
								reporterId: hostname().slice(0, 128),
								executor: executor.executor,
								lane: "supervisor-lead",
								running: true,
								observedAt: new Date(this.now()).toISOString(),
								lastAdmissionAt: null,
								slotsInUse: 0,
								slotsTotal: 1,
								topReason: { reason, count: 1 },
							}),
						],
						15_000,
					);
				} catch {
					this.log(`${executor.executor} health report failed`);
				}
				if (ok) return;
			}
			this.failed = true;
			this.log(
				"all configured executors failed; next pass follows the configured cadence",
			);
		} finally {
			lock.release();
		}
	}
}
