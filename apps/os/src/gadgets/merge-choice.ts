import type { OutputMergePreference } from "@tedix/api-contract/utils/output-merge";

/**
 * Ask which version wins where someone else's save and this unsaved draft
 * changed the same cell, slide element or paragraph. Every other change from
 * both sides is kept either way.
 */
export function showMergeChoice(
	target: HTMLElement,
	revision: number,
	choose: (prefer: OutputMergePreference) => void,
) {
	const text = document.createElement("span");
	text.textContent = `Revision ${revision} changed some of the same parts you are editing. Choose which version to keep there; all other changes from both of you are kept. `;
	const option = (label: string, prefer: OutputMergePreference) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.onclick = () => choose(prefer);
		return button;
	};
	target.replaceChildren(
		text,
		option("Keep mine", "mine"),
		" ",
		option("Use theirs", "theirs"),
	);
}
