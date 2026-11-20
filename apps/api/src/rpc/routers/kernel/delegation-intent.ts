/**
 * Kernel — the undispatched-promise check.
 *
 * Reads Home's own answer, never the person's message. A Home answer may not
 * say a delegation will happen when no route dispatches one: the answer is
 * cleared so the answer pass writes the reply from context.
 *
 * Pure, synchronous, no imports from the planner runtime.
 */

import type { KernelRouteDecision } from "./route-schema";

const ASKED_TEDI_TASK_VERBS =
	"do|handle|take|run|own|build|work|fetch|pull|check|verify|fix|write|draft|prepare|investigate|look|read|review|summari[sz]e|research|analy[sz]e";

/** Nouns alone are never promises: only "I will / we will <hand this on>". */
const DELEGATION_PROMISE = new RegExp(
	`\\b(?:I(?:['’]ll|\\s+will|\\s+am\\s+going\\s+to)|we(?:['’]ll|\\s+will|\\s+are\\s+going\\s+to))\\s+(?:delegate|assign|hand\\s*(?:off|over)|(?:have|ask|tell)\\s+(?:the\\s+)?[\\w-]+(?:\\s+tedi)?\\s+(?:to\\s+)?(?:${ASKED_TEDI_TASK_VERBS})|(?:prepare|create|open)\\s+[^.?!\\n]{0,40}\\b(?:work\\s*(?:order|item)|task))\\b`,
	"i",
);

/** Applied to every planner decision; all but the case above pass untouched. */
export function guardKernelRouteDecision<T extends KernelRouteDecision>(
	decision: T,
): T {
	if (
		decision.routeKind === "answer_in_home" &&
		decision.answer &&
		DELEGATION_PROMISE.test(decision.answer)
	) {
		return {
			...decision,
			answer: null,
			rationale: `${decision.rationale} [kernel guard: removed an undispatched delegation promise]`,
		};
	}
	return decision;
}
