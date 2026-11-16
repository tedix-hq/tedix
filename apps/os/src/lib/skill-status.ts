import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import type { SkillDraftReason } from "@/lib/skill-draft-reason";

export type SkillStatus = {
	label: "Active" | "Off" | "Draft";
	tone: "success" | "neutral" | "warning";
	/** One plain sentence on why, when the state needs one. */
	reason: string | null;
};

/**
 * The state a person sees: on, turned off, or a draft that has not run.
 * A draft that has run — and was then turned off, by a person or by failed
 * runs — reads "Off"; the reason comes from the draft explanation.
 */
export function skillStatus(
	skill: Pick<SkillEntry, "lifecycleState">,
	draft: Pick<SkillDraftReason, "kind" | "title"> | null,
): SkillStatus {
	const state = skill.lifecycleState;
	if (state === "archived")
		return { label: "Off", tone: "neutral", reason: "It was archived." };
	if (state !== "draft")
		return { label: "Active", tone: "success", reason: null };
	if (
		draft &&
		(draft.kind === "never_run" ||
			draft.kind === "proposal" ||
			draft.kind === "changed")
	)
		return { label: "Draft", tone: "warning", reason: draft.title };
	return { label: "Off", tone: "neutral", reason: draft?.title ?? null };
}
