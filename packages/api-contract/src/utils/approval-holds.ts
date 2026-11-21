import type { ApprovalMode } from "../schemas/workspace-agent-access";

export type ActionClass =
	/** A read that asks when nothing else says so, such as a new web site. */
	| "read"
	/** A change to this workspace's own files, apps or Work. */
	| "change"
	/** Commands and changes outside the workspace, such as on a computer. */
	| "outside"
	/**
	 * What Tedix always asks for: deleting or removing content, human-only
	 * steps, messages and posts to people, money, another organization and
	 * destructive computer commands.
	 */
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

const ORGANIZATION_KEYS = ["organizationId", "orgId", "organization_id"];

/** Workspace approval modes retain their original three-level argument scan. */
export function namesOtherOrganization(
	value: unknown,
	organizationId: string,
	maxDepth = 3,
): boolean {
	const pending = [{ value, depth: 0 }];
	const seen = new WeakSet<object>();
	while (pending.length) {
		const current = pending.pop()!;
		if (
			!current.value ||
			typeof current.value !== "object" ||
			current.depth > maxDepth ||
			seen.has(current.value)
		)
			continue;
		seen.add(current.value);
		for (const [key, inner] of Object.entries(current.value)) {
			if (
				ORGANIZATION_KEYS.includes(key) &&
				typeof inner === "string" &&
				inner !== organizationId
			)
				return true;
			if (inner && typeof inner === "object")
				pending.push({ value: inner, depth: current.depth + 1 });
		}
	}
	return false;
}
