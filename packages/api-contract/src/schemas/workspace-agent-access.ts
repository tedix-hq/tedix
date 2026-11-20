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
