/** `tedix hooks <name>`: agent-host lifecycle hooks that read the host event on stdin. */
import { runAgentStatus, STATUS_EVENT_LIMIT, statusLog } from "./agent-status";
import { runAwaitDraft } from "./await-draft";
import { runAwaitReply } from "./await-reply";
import { runDecisionCapture } from "./decision-capture";
import { cliRead, type HookDeps, readBoundedStdin } from "./hook-io";
import { runPromptContext } from "./prompt-context";
import { runSessionStart } from "./session-start";

export const hooksUsage = `Agent-host lifecycle hooks (installed by the Tedix plugin)

  tedix hooks session-start   SessionStart: opt-in read-only Tedix preflight
  tedix hooks prompt-context  UserPromptSubmit: selected shared decisions and Work updates
  tedix hooks capture-stop    Stop: open a decision-capture Interaction (opt-in)
  tedix hooks capture-reply   UserPromptSubmit: answer it with the user's reply (opt-in)
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
	"session-start": 1_048_576,
	"prompt-context": 1_048_576,
	"capture-stop": 4_194_304,
	"capture-reply": 4_194_304,
	"await-reply": 4_194_304,
	"await-draft": 4_194_304,
	status: STATUS_EVENT_LIMIT,
};

export async function runHooksCommand(args: string[]): Promise<number> {
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
	const deps: HookDeps = {
		env: process.env,
		stdin,
		cwd: process.cwd(),
		read: cliRead,
		write: (line) => console.log(line),
	};
	if (name === "status") {
		// Never disturb the host turn: no stdout or stderr, failures go to the local log.
		try {
			await runAgentStatus({ env: process.env, stdin, cwd: process.cwd() });
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
		if (name === "session-start") await runSessionStart(deps);
		else if (name === "prompt-context") await runPromptContext(deps);
		else
			await runDecisionCapture(
				name === "capture-stop" ? "stop" : "reply",
				deps,
			);
	} catch {
		if (name === "session-start")
			console.error(
				"Tedix preflight failed without changing session authority.",
			);
	}
	return 0;
}
