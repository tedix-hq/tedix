import { namesOtherOrganization } from "@tedix/api-contract/utils/approval-holds";
/**
 * Which of the agent's actions wait for the person, by approval mode. Every
 * call a binding makes is put in one class; one table says, per mode, whether
 * a call of that class runs, asks the person or is refused. The compliance
 * gate applies it to every wrapped binding in workspace chat.
 */
import type { RiskTier } from "@tedix/agent-governance/types";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import { isDestructiveCommand } from "./destructive-commands";

import type { ActionClass } from "@tedix/api-contract/utils/approval-holds";
import type { ApprovalMode } from "@tedix/api-contract/schemas/workspace-agent-access";

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

/** Changing files or running a command on a computer. */
export const MACHINE_WRITE_RESOURCE = "machine_write";

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

/** A tedi tool call; the gate holds it when its name sends, publishes or pays. */
export const TEDI_TOOL_RESOURCE = "tedi_tool";

/** Classes of the shared vocabulary that ask in every mode, by tool name. */
const ALWAYS_TOOL_CLASSES = new Set([
	"external_message",
	"public_publish",
	"money",
]);

/** Outbound verbs the shared vocabulary leaves to the sentence around them. */
const OUTBOUND_WORDS = new Set(["reply", "forward", "post"]);

/**
 * A connected tool whose name sends a message, publishes or moves money,
 * read with the same vocabulary Home and the runtime use.
 */
export function toolAlwaysAsks(tool: string): boolean {
	const words = tool
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	return (
		words.some((word) => OUTBOUND_WORDS.has(word)) ||
		humanReservedActionClasses(tool).some((id) => ALWAYS_TOOL_CLASSES.has(id))
	);
}

/**
 * A computer call that can destroy data: closing a checkout removes its
 * files, and a command line on the destructive list.
 */
function machineCallDestroys(call: unknown): boolean {
	const { tool, input } = (call ?? {}) as { tool?: unknown; input?: unknown };
	if (tool === "close_workspace") return true;
	const { command, workspace } = (input ?? {}) as {
		command?: unknown;
		workspace?: unknown;
	};
	return (
		tool === "run_command" &&
		typeof command === "string" &&
		isDestructiveCommand(command, { inWorkspace: Boolean(workspace) })
	);
}

function alwaysAsks(call: {
	resource: string;
	args: unknown[];
	organizationId?: string;
}): boolean {
	const [first] = call.args;
	if (call.resource === MACHINE_WRITE_RESOURCE && machineCallDestroys(first))
		return true;
	if (call.resource === TEDI_TOOL_RESOURCE) {
		const tool = (first as { tool?: unknown } | null | undefined)?.tool;
		if (typeof tool === "string" && toolAlwaysAsks(tool)) return true;
	}
	return Boolean(
		call.organizationId &&
		namesOtherOrganization(call.args, call.organizationId),
	);
}

export function actionClass(call: {
	resource: string;
	operation: string;
	riskTier?: RiskTier;
	destructive?: boolean;
	args: unknown[];
	/** The sender's organization; a call naming another one always asks. */
	organizationId?: string;
}): ActionClass {
	if (call.resource === COMPUTER_READ_RESOURCE) return "computer_read";
	if (!call.riskTier || call.riskTier === "read") return "read";
	if (
		call.destructive ||
		HUMAN_ONLY.has(`${call.resource}.${call.operation}`) ||
		removesContent(call.args) ||
		alwaysAsks(call)
	)
		return "always";
	if (HELD_READS.has(call.resource)) return "read";
	// Publishing a conversation app draft is a bounded workspace change.
	return call.riskTier === "bounded_write" ? "change" : "outside";
}

/**
 * The gate's fourth outcome next to run, ask and refuse: the call is still
 * held, and instead of waiting it is staged for this conversation. The agent
 * keeps working on the staged state; the person accepts or rejects it on the
 * conversation's review card, and nothing real changes before that.
 */
export const STAGED_REASON = "staged_for_review";

/** Writes to data Tedix stores itself that stage, by gate resource. */
const STAGED_WRITES: Record<string, readonly string[]> = {
	output: ["create", "revise", "replace", "edit"],
	work: ["create", "comment", "accept"],
};

/**
 * Whether a held call stages instead of waiting on a card. Only a turn a
 * signed-in person sent themself, only in the two asking modes, and only a
 * change to a workspace file or a Work Item: what Tedix always asks for
 * (removing content, deleting, outside messages, publishing, money, another
 * organization) and every connected outside service keep asking.
 */
export function stagesCall(call: {
	resource: string;
	operation: string;
	args: unknown[];
	cls: ActionClass;
	mode: ApprovalMode;
	personSent: boolean;
}): boolean {
	return (
		call.personSent &&
		(call.mode === "ask_every_time" || call.mode === "ask_for_changes") &&
		call.cls === "change" &&
		!removesContent(call.args) &&
		(STAGED_WRITES[call.resource]?.includes(call.operation) ?? false)
	);
}

/** What a call refused by the mode returns, in place of the gate's reason. */
export const READ_ONLY_REFUSAL =
	"Nothing was changed: Read only is on for this chat, so the agent may only read. The person can pick another approval mode under the message box to allow changes.";
