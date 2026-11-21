/**
 * What the agent and tedis may do in a workspace's chat: whether they may use
 * the computer of the person who sent the message, and how often they ask
 * before acting. Both workspace settings are stored on the workspace row; a
 * null value means the default, which follows the workspace's visibility.
 */

import * as z from "zod";

/** From strictest to loosest; a workspace's highest mode caps every pick. */
export const APPROVAL_MODES = [
	"read_only",
	"ask_every_time",
	"ask_for_changes",
	"auto",
] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/** A person's mode before they pick one: how the chat has always asked. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask_every_time";

interface AgentAccessSettings {
	visibility: "org" | "private";
	machineAccess?: boolean | null;
	highestApprovalMode?: ApprovalMode | null;
}

/** On in a private workspace and off in one other people can open, unless set. */
export function workspaceMachineAccess(workspace: AgentAccessSettings) {
	return workspace.machineAccess ?? workspace.visibility === "private";
}

/** Auto in a private workspace and "Ask for changes" in a shared one, unless set. */
export function workspaceHighestApprovalMode(
	workspace: AgentAccessSettings,
): ApprovalMode {
	return (
		workspace.highestApprovalMode ??
		(workspace.visibility === "private" ? "auto" : "ask_for_changes")
	);
}

/** The person's pick, or the workspace's highest mode when the pick is looser. */
export function capApprovalMode(
	mode: ApprovalMode,
	highest: ApprovalMode,
): ApprovalMode {
	return APPROVAL_MODES.indexOf(mode) <= APPROVAL_MODES.indexOf(highest)
		? mode
		: highest;
}

/** What the agent says, and a machine call answers, while the setting is off. */
export const COMPUTER_ACCESS_OFF =
	"Computer access is off for this workspace. Someone who can edit the workspace can switch it on in Edit workspace, or use your private workspace.";

/**
 * One shape of command line that only reads, such as `git -C <path> log`.
 * An organization keeps its own list in its settings; without one the
 * platform's list applies. In `argv`, `<path>` is any word not starting with
 * `-`, `<n>` is a number, `<health-url>` is `https://<host>/health` and a
 * word ending in `*` matches by its start.
 */
export const ReadOnlyCommandPatternSchema = z.strictObject({
	argv: z.array(z.string().min(1)).min(1).max(12),
	/** Whether more words may follow `argv`. */
	rest: z.enum(["any", "none"]),
	/** Options that may not appear after `argv`, such as `-X` or `--method`. */
	forbid: z.array(z.string().min(2)).max(30).optional(),
	/** The last word must be a file under this folder, written as `~/...`. */
	fileUnder: z.string().startsWith("~/").optional(),
	/** At most this many words after `argv` that are not options. */
	maxOperands: z.number().int().min(0).max(20).optional(),
	/** Every word after `argv` that is not an option starts with this. */
	operandPrefix: z.string().min(1).optional(),
});
export type ReadOnlyCommandPattern = z.infer<
	typeof ReadOnlyCommandPatternSchema
>;
export const ReadOnlyCommandListSchema = z
	.array(ReadOnlyCommandPatternSchema)
	.max(200);
