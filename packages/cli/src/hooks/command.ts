/** `tedix hooks <name>`: agent-host lifecycle hooks that read the host event on stdin. */
import { isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { selfCommand } from "../shared";
import { readAuthStatus } from "../auth-resolve";
import { parseOptions } from "../options";
import { runAgentStatus, STATUS_EVENT_LIMIT, statusLog } from "./agent-status";
import { runAwaitDraft } from "./await-draft";
import { runAwaitReply } from "./await-reply";
import { runDecisionCapture } from "./decision-capture";
import {
	cliRead,
	type HookDeps,
	type ReadJson,
	PROFILE,
	readBoundedStdin,
} from "./hook-io";
import { runPromptContext } from "./prompt-context";
import { runSessionFeedback } from "./session-feedback";
import { runRequestLedger } from "./request-ledger";
import { runSituationalRecall } from "./situational-recall";
import { runSessionStart } from "./session-start";
import {
	devinContextOutput,
	devinHookEvent,
	skipInheritedDevinHook,
} from "./devin-event";
import { devinPermissionBlock } from "./devin-permission";

export const hooksUsage = `Agent-host lifecycle hooks (installed by the Tedix plugin)

  tedix hooks situational-recall PreToolUse: matching brain lessons, advisory only
  tedix hooks session-start   SessionStart: opt-in read-only Tedix preflight
  tedix hooks prompt-context  UserPromptSubmit: selected shared decisions, Work updates
                              and open requests
  tedix hooks capture-stop    Stop: open a decision-capture Interaction and upload
                              the turn and its activity for the request ledger (opt-in)
  tedix hooks capture-reply   UserPromptSubmit: answer it with the user's reply and
                              upload the message for the request ledger (opt-in)
  tedix hooks await-reply     Stop (Claude Code asyncRewake): wake on a Tedix OS answer or auto reply (opt-in)
  tedix hooks await-draft     Stop (Codex only): continue with a tedi auto reply, 5 min max (opt-in)
  tedix hooks status          Turn boundaries: local turn status, notification and report (opt-in)

Each reads one host event JSON object on stdin and exits 0; await-reply exits 2
with the answer on stderr when the user answers in Tedix OS or a tedi auto
reply arrives, and await-draft prints a Codex Stop continuation
({"decision":"block","reason":...}) for an auto reply. Read hooks never
send or store prompt text. Capture runs only after
tedix setup agents context enable-decision-capture. Status reporting runs
only with ~/.tedix/agent-status.json {"enabled": true} or TEDIX_AGENT_STATUS=1.`;

const EVENT_LIMITS: Record<string, number> = {
	"devin-permission": 4_194_304,
	"situational-recall": 1_048_576,
	"session-start": 1_048_576,
	"prompt-context": 1_048_576,
	"capture-stop": 4_194_304,
	"capture-reply": 4_194_304,
	"await-reply": 4_194_304,
	"await-draft": 4_194_304,
	status: STATUS_EVENT_LIMIT,
};

/** Local auth inspection must not wait for another CLI process to start. */
export const readHookCommand: ReadJson = async (
	args,
	timeout,
	input,
	options,
) => {
	if (
		args.length === 5 &&
		args[0] === "-w" &&
		PROFILE.test(args[1] ?? "") &&
		args.slice(2).join(" ") === "auth status --json" &&
		input === undefined &&
		(options?.cwd === undefined || options.cwd === process.cwd()) &&
		(!options?.env || options.env === process.env)
	)
		return JSON.parse(
			JSON.stringify(readAuthStatus(parseOptions(args).options)),
		);
	return cliRead(args, timeout, input, options);
};

export async function runHooksCommand(args: string[]): Promise<number> {
	if (skipInheritedDevinHook(args, process.env)) return 0;
	const devin = args[1] === "--host" && args[2] === "devin";
	if (devin && args.length !== 3) return 1;
	if (devin) args = [args[0]!];
	const name = args[0];
	if (!name || name === "--help" || name === "-h") {
		console.log(hooksUsage);
		return 0;
	}
	const limit = EVENT_LIMITS[name];
	if (!limit || args.length > 1) {
		console.error(`Unknown hook "${args.join(" ")}". Run tedix hooks --help.`);
		// Exit 1 is a non-blocking error for every host event; 2 would block a prompt.
		return 1;
	}
	let stdin = "";
	try {
		stdin = await readBoundedStdin(limit);
	} catch {
		// An unreadable event is handled like a malformed one below.
		stdin = "\u0000";
	}
	if (name === "devin-permission") {
		const root = process.env.TEDIX_DEVIN_LANE_ROOT;
		if (!devin || !root) return 0;
		let reason: string | undefined;
		try {
			reason = devinPermissionBlock(stdin, root);
		} catch {
			reason = "Devin lane permission check failed";
		}
		if (reason) {
			console.log(JSON.stringify({ decision: "block", reason }));
			return 2;
		}
		return 0;
	}
	let env = process.env;
	if (devin) {
		try {
			const normalized = devinHookEvent(stdin, env);
			stdin = normalized.stdin;
			env = normalized.env;
		} catch {
			return 0;
		}
	}
	let cwd = process.cwd();
	try {
		const event = JSON.parse(stdin);
		if (typeof event.cwd === "string" && isAbsolute(event.cwd)) cwd = event.cwd;
	} catch {}
	const deps: HookDeps = {
		env,
		stdin,
		cwd,
		read: (args, timeout, input, options) =>
			readHookCommand(args, timeout, input, { cwd, env, ...options }),
		write: (line) =>
			console.log(
				devin ? devinContextOutput(line, env.DEVIN_SESSION_ID!) : line,
			),
		deferRead: (args, input) => {
			const [command, prefix] = selfCommand();
			const child = spawn(command, [...prefix, ...args], {
				cwd,
				env: { ...env, TEDIX_HOOK_READ: "1" },
				detached: process.platform !== "win32",
				stdio: ["pipe", "ignore", "ignore"],
			});
			child.on("error", () => {});
			child.stdin.on("error", () => {});
			child.stdin.end(input);
			child.unref();
		},
	};
	if (name === "status") {
		// Never disturb the host turn: no stdout or stderr, failures go to the local log.
		try {
			await runAgentStatus({ env, stdin, cwd });
		} catch (error) {
			statusLog(
				process.env,
				`agent status failed: ${(error as Error).name}: ${String((error as Error).message).slice(0, 200)}`,
			);
		}
		return 0;
	}
	if (name === "await-reply") {
		// asyncRewake: exit 2 wakes the session and shows stderr to the agent.
		const result = await runAwaitReply(deps);
		if (result.code === 2 && result.message) {
			console.error(result.message);
			return 2;
		}
		return 0;
	}
	if (name === "await-draft") {
		// Codex Stop: JSON on stdout continues the turn; no output lets it end.
		const continuation = await runAwaitDraft(deps);
		if (continuation) console.log(continuation);
		return 0;
	}
	try {
		if (name === "capture-stop") {
			const { hostEvent } = await import("./hook-io");
			const { harnessOf } = await import("./agent-status");
			const { heartbeatLaneSession } = await import("../lane");
			const { event, session } = hostEvent(deps.stdin, deps.env, limit);
			if (session)
				heartbeatLaneSession(
					`${harnessOf(event, deps.env)}:${session}`,
					deps.env,
				);
		}
		if (name === "situational-recall") await runSituationalRecall(deps);
		else if (name === "session-start") await runSessionStart(deps);
		else if (name === "prompt-context") await runPromptContext(deps);
		else
			// The request ledger rides on the same events and opt-in.
			await Promise.all([
				runDecisionCapture(name === "capture-stop" ? "stop" : "reply", deps),
				runRequestLedger(name === "capture-stop" ? "turn" : "prompt", deps),
				runSessionFeedback(name === "capture-stop" ? "turn" : "prompt", deps),
			]);
	} catch {
		if (name === "session-start")
			console.error(
				"Tedix preflight failed without changing session authority.",
			);
	}
	return 0;
}
