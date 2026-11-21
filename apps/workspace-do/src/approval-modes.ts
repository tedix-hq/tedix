/**
 * Which of the agent's actions wait for the person, by approval mode. Every
 * call a binding makes is put in one class; one table says, per mode, whether
 * a call of that class runs, asks the person or is refused. The compliance
 * gate applies it to every wrapped binding in workspace chat.
 */
import type { ApprovalMode } from "@tedix/api-contract/schemas/workspace-agent-access";
import type { RiskTier } from "@tedix/agent-governance/types";

export type ActionClass =
	/** A read that asks when nothing else says so, such as a new web site. */
	| "read"
	/** A change to this workspace's own files, apps or Work. */
	| "change"
	/** Commands and changes outside the workspace, such as on a computer. */
	| "outside"
	/** What Tedix always asks for: deleting or removing content, human-only steps. */
	| "always"
	/** Reading a person's computer where other people can open the workspace. */
	| "computer_read";

export type Hold = "run" | "ask" | "refuse";

export const HOLDS: Record<ActionClass, Record<ApprovalMode, Hold>> = {
	read: {
		read_only: "run",
		ask_every_time: "ask",
		ask_for_changes: "run",
		auto: "run",
	},
	change: {
		read_only: "refuse",
		ask_every_time: "ask",
		ask_for_changes: "ask",
		auto: "run",
	},
	outside: {
		read_only: "refuse",
		ask_every_time: "ask",
		ask_for_changes: "ask",
		auto: "run",
	},
	always: {
		read_only: "refuse",
		ask_every_time: "ask",
		ask_for_changes: "ask",
		auto: "ask",
	},
	computer_read: {
		read_only: "ask",
		ask_every_time: "ask",
		ask_for_changes: "ask",
		auto: "ask",
	},
};

/** Steps only a person takes, by gate resource and method. */
const HUMAN_ONLY = new Set(["memory.review"]);

/**
 * A command on the sender's own computer whose whole line only reads, in a
 * workspace nobody else can open. It asks only under "Ask every time".
 */
export const COMMAND_READ_RESOURCE = "machine_command_read";

/** Gates that hold a read: the first page from a new web site, a read-only command. */
const HELD_READS = new Set(["web_domain", COMMAND_READ_RESOURCE]);

/** Reading a computer: held only where other people can open the workspace. */
export const COMPUTER_READ_RESOURCE = "machine_read";

/** An edit that removes blocks, cells or slides deletes content. */
export function removesContent(args: unknown[]): boolean {
	const ops = (args[0] as { ops?: unknown } | null | undefined)?.ops;
	return (
		Array.isArray(ops) &&
		ops.some((op) => {
			const name =
				op && typeof op === "object" ? (op as { op?: unknown }).op : null;
			return typeof name === "string" && /delete|remove|archive/i.test(name);
		})
	);
}

export function actionClass(call: {
	resource: string;
	operation: string;
	riskTier?: RiskTier;
	destructive?: boolean;
	args: unknown[];
}): ActionClass {
	if (call.resource === COMPUTER_READ_RESOURCE) return "computer_read";
	if (!call.riskTier || call.riskTier === "read") return "read";
	if (
		call.destructive ||
		HUMAN_ONLY.has(`${call.resource}.${call.operation}`) ||
		removesContent(call.args)
	)
		return "always";
	if (HELD_READS.has(call.resource)) return "read";
	return call.riskTier === "bounded_write" ? "change" : "outside";
}

/** What a call refused by the mode returns, in place of the gate's reason. */
export const READ_ONLY_REFUSAL =
	"Nothing was changed: Read only is on for this chat, so the agent may only read. The person can pick another approval mode under the message box to allow changes.";
