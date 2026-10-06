import type { ApprovalPromptState, QuestionPromptState } from "./ink-repl";

export interface InteractionContext {
	question: string | null;
	approval: string | null;
	picker: boolean;
}
export type KeyboardOwner =
	| "composer"
	| "question_choices"
	| "question_editor"
	| "approval"
	| "sessions"
	| "decision_detail"
	| "queue_detail";
export type InteractionMode =
	| { kind: "default" }
	| { kind: "question_editor"; identity: string }
	| { kind: "decision_detail"; identity: string; resumeEditor: boolean }
	| { kind: "queue_detail"; entries: string[] };
export type InteractionEvent =
	| { type: "edit_question" }
	| { type: "inspect_decision" }
	| { type: "inspect_queue"; entries: string[] }
	| { type: "back" }
	| { type: "reset" };

/** Polling objects may change; only the actual decision specification owns focus. */
export function questionIdentity(
	prompt: QuestionPromptState | null,
): string | null {
	return prompt
		? JSON.stringify([prompt.homeRunId, prompt.prompt, prompt.options])
		: null;
}
export function approvalIdentity(
	prompt: ApprovalPromptState | null,
): string | null {
	return prompt
		? JSON.stringify([
				prompt.homeRunId,
				prompt.targetLabel,
				prompt.detail,
				prompt.reason,
				prompt.scope,
				prompt.scopeLabel,
			])
		: null;
}
export function keyboardOwner(
	context: InteractionContext,
	mode: InteractionMode,
): KeyboardOwner {
	if (context.question) {
		if (mode.kind === "decision_detail" && mode.identity === context.question)
			return "decision_detail";
		return mode.kind === "question_editor" && mode.identity === context.question
			? "question_editor"
			: "question_choices";
	}
	if (context.approval)
		return mode.kind === "decision_detail" && mode.identity === context.approval
			? "decision_detail"
			: "approval";
	if (context.picker) return "sessions";
	return mode.kind === "queue_detail" ? "queue_detail" : "composer";
}

/** Mode changes are applied to a ref synchronously before the next stdin event. */
export function transitionInteraction(
	context: InteractionContext,
	mode: InteractionMode,
	event: InteractionEvent,
): InteractionMode {
	const owner = keyboardOwner(context, mode);
	if (event.type === "reset") return { kind: "default" };
	if (event.type === "back")
		return mode.kind === "decision_detail" &&
			mode.resumeEditor &&
			mode.identity === context.question
			? { kind: "question_editor", identity: mode.identity }
			: { kind: "default" };
	if (event.type === "edit_question")
		return context.question
			? { kind: "question_editor", identity: context.question }
			: mode;
	if (event.type === "inspect_queue") {
		if (owner === "queue_detail") return { kind: "default" };
		return owner === "composer" && event.entries.length > 0
			? { kind: "queue_detail", entries: [...event.entries] }
			: mode;
	}
	if (owner === "decision_detail")
		return transitionInteraction(context, mode, { type: "back" });
	const identity = context.question ?? context.approval;
	return identity &&
		(owner === "question_choices" ||
			owner === "question_editor" ||
			owner === "approval")
		? {
				kind: "decision_detail",
				identity,
				resumeEditor: owner === "question_editor",
			}
		: mode;
}
