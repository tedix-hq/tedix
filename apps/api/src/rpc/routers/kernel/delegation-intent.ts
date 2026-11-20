/**
 * Kernel — delegation-intent label and the undispatched-promise check.
 *
 * Nothing here replaces Home's reply or changes its route because of how the
 * person worded the message.
 *
 *  - {@link hasExplicitDelegationIntent}: the person ASKED for delegation
 *    (delegate / assign / have <name> do / create a task / work item / kick
 *    off / start a job / run this as a job), English + Spanish. Used as a
 *    label on the decision and to keep the output-create shortcut from
 *    taking a message that asks for a delegation.
 *  - {@link guardKernelRouteDecision}: stamps `explicitDelegationIntent` on
 *    every decision, and clears a Home answer that says a delegation will
 *    happen when no delegation is dispatched. That check reads Home's own
 *    answer, never the person's message.
 *
 * Pure, synchronous, no imports from the planner runtime.
 */

import type { KernelRouteDecision } from "./route-schema";

// Verb-led delegation asks. `have/let/get/make <name> do|handle|…` covers the
// "have the CTO do it" family without naming a roster (the planner already
// resolves the target). Spanish mirrors: delega/asigna/encarga/que lo haga.
const TEDI_TASK_VERBS =
	"do|handle|take|run|own|build|work|fetch|pull|check|verify|fix|write|draft|prepare|investigate|look";
// Only after "ask/tell <name> to": "let me read" is not a handoff.
const ASKED_TEDI_TASK_VERBS = `${TEDI_TASK_VERBS}|read|review|summari[sz]e|research|analy[sz]e`;
const EXPLICIT_DELEGATION_PATTERNS: readonly RegExp[] = [
	/^(?:please\s+)?(?:coding\s+)?(?:task|trial|goal)\s+for\s+(?:(?:a|an|the)\s+)?(?:[\w-]+\s+){0,3}tedi\b/i,
	/\bdelegat(?:e|es|ed|ing|ion)\b/i,
	/\bassign(?:s|ed|ing)?\b/i,
	new RegExp(
		`\\b(?:(?:have|let|get|make|ask|tell)\\s+(?:the\\s+)?[\\w-]+(?:\\s+tedi)?)\\s+(?:${TEDI_TASK_VERBS})\\b|\\b(?:ask|tell)\\s+(?:the\\s+)?[\\w-]+(?:\\s+tedi)?\\s+to\\s+(?:${ASKED_TEDI_TASK_VERBS})\\b`,
		"i",
	),
	/\bcreate\s+(?:a\s+|an\s+|new\s+)?(?:task|ticket|work\s*item|job)\b/i,
	/\b(?:open|file|log|add)\s+(?:a\s+|an\s+|new\s+)?(?:task|ticket|work\s*item)\b/i,
	/\bwork\s*item\b/i,
	/\bkick\s*off\b/i,
	/\bstart\s+(?:a\s+|the\s+|this\s+)?(?:job|task|run|background\s+job)\b/i,
	/\brun\s+(?:this|it|that)\s+as\s+(?:a\s+)?(?:job|task|background\s+job)\b/i,
	/\bhand(?:\s+(?:this|it|that))?\s+(?:off|over)\b|\bhand-?(?:off|over)\s+(?:this|it|that|to)\b/i,
	/\bwork\s+order\b/i,
	// Spanish
	/\bdeleg(?:a|ar|ue|alo|arlo|uen|ando|ación|acion)\b/i,
	/\basign(?:a|ar|alo|arlo|e|en|ando|ación|acion)\b/i,
	/\bencarg(?:a|ar|alo|arlo|ue|uen|ando)\b/i,
	/\b(?:que|haz\s+que|pide\s+que|dile\s+a)\s+(?:el\s+|la\s+|al\s+)?[\w-]+(?:\s+tedi)?\s+(?:lo\s+|la\s+|se\s+)?(?:haga|hagan|se\s+encargue|se\s+ocupe|revise|verifique|prepare|investigue)\b/i,
	/\bcre(?:a|ar|e|en)\s+(?:una?\s+|nuev[oa]\s+)?(?:tarea|ticket|elemento\s+de\s+trabajo|trabajo)\b/i,
	/\b(?:abre|abrir|registra|registrar)\s+(?:una?\s+|nuev[oa]\s+)?(?:tarea|ticket|elemento\s+de\s+trabajo)\b/i,
	/\belemento\s+de\s+trabajo\b/i,
	/\b(?:lanza|lanzar|inicia|iniciar|arranca|arrancar)\s+(?:un\s+|una\s+|el\s+|la\s+|este\s+|esta\s+)?(?:trabajo|tarea|job|proceso|ejecuci[oó]n)\b/i,
	/\bejec[uú]t(?:a|alo|arlo|ar)\s+(?:esto|eso)\s+como\s+(?:un\s+)?(?:trabajo|job|tarea)\b/i,
	/\borden\s+de\s+trabajo\b/i,
];

/**
 * True when the operator explicitly asked for delegation, a task/Work Item, or
 * a background job. English + Spanish. Conservative by design: a plain read
 * ("list my work items") must NOT match — `work item` as a NOUN the operator
 * is asking ABOUT is excluded when the sentence is a read verb over it.
 */
export function hasExplicitDelegationIntent(content: string): boolean {
	const text = content.trim();
	if (!text) return false;
	// Negative safety constraints are not delegation requests. Strip the
	// bounded negated phrase before running the positive matcher so prompts such
	// as "do not use tools, delegate, create work, or change data" cannot stamp
	// governance metadata with explicitDelegationIntent=true merely because the
	// prohibited verb appears in the sentence.
	const withoutNegatedDelegation = text.replace(
		/\b(?:do\s+not|don't|never|without|no)\b[^.?!\n]{0,100}?\b(?:delegat(?:e|es|ed|ing|ion)|assign(?:s|ed|ing)?|hand(?:\s+(?:this|it|that))?(?:\s*|-)?(?:off|over)|work\s+orders?|delegaci(?:o|ó)n|delegar|asignar|orden(?:es)?\s+de\s+trabajo)\b/gi,
		" ",
	);
	// A read over work items ("list/show/what are my work items") is a read,
	// not a request to mint one. Strip that noun phrase before matching so the
	// bare `work item` / `elemento de trabajo` patterns only fire for asks like
	// "create a work item for …" / "open a work item".
	const withoutReadNoun = withoutNegatedDelegation.replace(
		/\b(?:list|show|display|get|fetch|find|search|count|summari[sz]e|what(?:'s| is| are)|which|how many|render|print|give me|tell me|muestra|muéstrame|lista|listar|enumera|cu[aá]les|cu[aá]ntos|dame|dime|resume|resumir)\b[^.?!\n]{0,80}?\b(?:work\s*items?|elementos?\s+de\s+trabajo|work\s+orders?|[oó]rdenes\s+de\s+trabajo)\b/gi,
		" ",
	);
	return EXPLICIT_DELEGATION_PATTERNS.some((pattern) =>
		pattern.test(withoutReadNoun),
	);
}

/** Answer prose is not an operator request: nouns alone are never promises. */
const DELEGATION_PROMISE = new RegExp(
	`\\b(?:I(?:['’]ll|\\s+will|\\s+am\\s+going\\s+to)|we(?:['’]ll|\\s+will|\\s+are\\s+going\\s+to))\\s+(?:delegate|assign|hand\\s*(?:off|over)|(?:have|ask|tell)\\s+(?:the\\s+)?[\\w-]+(?:\\s+tedi)?\\s+(?:to\\s+)?(?:${ASKED_TEDI_TASK_VERBS})|(?:prepare|create|open)\\s+[^.?!\\n]{0,40}\\b(?:work\\s*(?:order|item)|task))\\b`,
	"i",
);
function promisesDelegation(answer: string): boolean {
	return DELEGATION_PROMISE.test(answer);
}

/**
 * Applied to every planner decision.
 *
 *  1. Stamps `explicitDelegationIntent` from the person's message. The stamp
 *     is a label only; it changes neither the route nor the reply.
 *  2. A Home answer may not say a delegation will happen when no route
 *     dispatches one. The answer is cleared so the answer pass writes the
 *     reply from context. This reads Home's own answer, not the message.
 *
 * Every other decision passes through untouched apart from the stamp.
 */
export function guardKernelRouteDecision<T extends KernelRouteDecision>(
	content: string,
	decision: T,
): T & { explicitDelegationIntent: boolean } {
	const explicitDelegationIntent = hasExplicitDelegationIntent(content);
	if (
		decision.routeKind === "answer_in_home" &&
		decision.answer &&
		promisesDelegation(decision.answer)
	) {
		return {
			...decision,
			answer: null,
			rationale: `${decision.rationale} [kernel guard: removed an undispatched delegation promise]`,
			explicitDelegationIntent,
		};
	}
	return { ...decision, explicitDelegationIntent };
}
