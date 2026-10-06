/**
 * Kernel — deterministic delegation-intent guard.
 *
 * The route planner is an LLM and drifts toward `delegate_tedi` for reads the
 * kernel can answer from its own assembled context (work items, objectives,
 * tedis, apps, workflows, runs, skills). Delegating such a
 * read ("list my 3 most recently updated work items") mints a Work Item,
 * shows nothing for about a minute, and fails a bounded read the kernel
 * already held.
 *
 * This leaf owns deterministic operator-intent matchers and the guard that
 * combines them:
 *
 *  - {@link hasExplicitDelegationIntent}: the operator ASKED for delegation
 *    (delegate / assign / have <name> do / create a task / work item / kick
 *    off / start a job / run this as a job), English + Spanish.
 *  - {@link mentionsTedixInternalState}: the message references Tedix-internal
 *    state the kernel already holds in context.
 *  - {@link guardKernelRouteDecision}: downgrades a low-risk, single-read
 *    `delegate_tedi` verdict with no explicit intent and no planned provider
 *    tools to `answer_in_home` (preserving only a direct answer), and stamps
 *    `explicitDelegationIntent` on every decision so the turn body can gate
 *    Work-Item minting on what the operator actually asked for.
 *
 * Pure, synchronous, no imports from the planner runtime.
 */

import type { KernelRouteDecision } from "./route-schema";

// Verb-led delegation asks. `have/let/get/make <name> do|handle|…` covers the
// "have the CTO do it" family without naming a roster (the planner already
// resolves the target). Spanish mirrors: delega/asigna/encarga/que lo haga.
const EXPLICIT_DELEGATION_PATTERNS: readonly RegExp[] = [
	/\bdelegat(?:e|es|ed|ing|ion)\b/i,
	/\bassign(?:s|ed|ing)?\b/i,
	/\b(?:have|let|get|make|ask|tell)\s+(?:the\s+)?[\w-]+(?:\s+tedi)?\s+(?:do|handle|take|run|own|build|work|fetch|pull|check|verify|fix|write|draft|prepare|investigate|look)\b/i,
	/\bcreate\s+(?:a\s+|an\s+|new\s+)?(?:task|ticket|work\s*item|job)\b/i,
	/\b(?:open|file|log|add)\s+(?:a\s+|an\s+|new\s+)?(?:task|ticket|work\s*item)\b/i,
	/\bwork\s*item\b/i,
	/\bkick\s*off\b/i,
	/\bstart\s+(?:a\s+|the\s+|this\s+)?(?:job|task|run|background\s+job)\b/i,
	/\brun\s+(?:this|it|that)\s+as\s+(?:a\s+)?(?:job|task|background\s+job)\b/i,
	/\bhand(?:\s*|-)?(?:off|over)\b/i,
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
		/\b(?:do\s+not|don't|never|without|no)\b[^.?!\n]{0,100}?\b(?:delegat(?:e|es|ed|ing|ion)|assign(?:s|ed|ing)?|hand(?:\s*|-)?(?:off|over)|work\s+orders?|delegaci(?:o|ó)n|delegar|asignar|orden(?:es)?\s+de\s+trabajo)\b/gi,
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

// Tedix-internal state the kernel already holds in its assembled context
// (context-assembly.ts): work items, objectives, tedis, apps, workflows, runs,
// skills. English + Spanish.
const INTERNAL_STATE_PATTERN =
	/\b(?:work\s*items?|objectives?|tedis?|apps?|applications?|workflows?|runs?|skills?|conversations?|delegations?|approvals?|elementos?\s+de\s+trabajo|objetivos?|aplicaci(?:ón|on|ones)|flujos?(?:\s+de\s+trabajo)?|ejecuci(?:ón|on|ones)|habilidades?|conversaci(?:ón|on|ones)|delegaci(?:ón|on|ones)|aprobaci(?:ón|on|ones))\b/i;

// The assembled app context names apps and capabilities, but deliberately does
// not claim which credentials are connected now. These reads need a live tool.
const LIVE_CONNECTION_STATE_PATTERN =
	/\b(?:gateway|connections?|connect(?:ed|ivity)|online|offline)\b/i;

/** True when the message references Tedix-internal state the kernel holds. */
export function mentionsTedixInternalState(content: string): boolean {
	return INTERNAL_STATE_PATTERN.test(content);
}

/** True when answering requires connection state absent from assembled context. */
export function requiresLiveConnectionState(content: string): boolean {
	return LIVE_CONNECTION_STATE_PATTERN.test(content);
}

/** Explicit response-only intent belongs to the operator, never retrieved context. */
export function requestsAcknowledgmentOnly(content: string): boolean {
	if (
		/\backnowledge\b[^.?!;\n]{0,60}\bthen\s+(?:execute|perform|delegate|run|create|prepare|dispatch|do)\b/i.test(
			content,
		)
	)
		return false;
	const text = content.replace(
		/\b(?:do\s+not|don't|never)\s+(?:(?:just|only)\s+(?:acknowledge|acknowledg[e]?ment)|(?:acknowledge|acknowledg[e]?ment)\s+only)\b/gi,
		" ",
	);
	return /\b(?:(?:just|only)\s+(?:acknowledge|acknowledg[e]?ment)|(?:acknowledge|acknowledg[e]?ment)\s+only|(?:reply|respond)\s+(?:only\s+)?with\s+(?:an?\s+)?acknowledg[e]?ment)\b/i.test(
		text,
	);
}

/** A dispatch hold on an explicitly prepared Work Order is not a prohibition. */
export function prohibitsDelegation(content: string): boolean {
	if (
		/\b(?:no\s+delegation|without\s+(?:any\s+)?delegation|never\s+(?:delegate|hand(?:\s+(?:this|it|that))?\s*(?:off|over)))\b/i.test(
			content,
		)
	)
		return true;
	const preparedWorkOrder =
		/\b(?:prepare|draft|create)\s+(?:a\s+|an\s+|the\s+)?[^.?!;\n]{0,60}\bwork\s*order\b/i.test(
			content,
		) && /\b(?:approval|approve|sign[ -]?off)\b/i.test(content);
	const text = preparedWorkOrder
		? content.replace(
				/\b(?:do\s+not|don't)\s+delegate\b[^.?!;\n]{0,60}\b(?:yet|before\s+approval|until\s+(?:approval|approved))\b/gi,
				" ",
			)
		: content;
	return /\b(?:do\s+not|don't|never)\s+(?:(?:use\s+tools|create\s+(?:work|outputs?)|change\s+(?:any\s+)?data)\s*(?:,\s*|or\s+|and\s+))*(?:delegate|hand(?:\s+(?:this|it|that))?\s*(?:off|over))\b/i.test(
		text,
	);
}

/** Answer prose is not an operator request: nouns alone are never promises. */
function promisesDelegation(answer: string): boolean {
	return /\b(?:I(?:['’]ll|\s+will|\s+am\s+going\s+to)|we(?:['’]ll|\s+will|\s+are\s+going\s+to))\s+(?:delegate|assign|hand\s*(?:off|over)|(?:have|ask|tell)\s+(?:the\s+)?[\w-]+(?:\s+tedi)?\s+(?:do|handle|take|run|own|build|work|fetch|pull|check|verify|fix|write|draft|prepare|investigate|look)|(?:prepare|create|open)\s+[^.?!\n]{0,40}\b(?:work\s*(?:order|item)|task))\b/i.test(
		answer,
	);
}

/**
 * Post-verdict deterministic guard. Applied to EVERY planner decision (all
 * provider results and once more after parked-approval coercion:
 *
 *  Explicit acknowledgment-only requests cannot recommend actions. Explicit
 *  no-delegation requests cannot recommend delegation or handoff, regardless
 *  of model-selected risk, effort, or tools. Positive preparation of a parked
 *  Work Order retains its temporal dispatch hold and existing approval policy.
 *
 *  1. Stamps `explicitDelegationIntent` from the operator message.
 *  2. Downgrades `delegate_tedi` → `answer_in_home` when ALL hold:
 *     - no explicit delegation intent in the message,
 *     - the planner classified the route low-risk and single-read (or left
 *       the effort class null),
 *     - the planner selected no provider tools (`plannedToolIds` empty) — a
 *       live provider read still belongs with the owning tedi,
 *     - the message references Tedix-internal state the kernel already holds.
 *     A direct `answer` is preserved; delegation-promising copy is cleared so
 *     the answer pass fills it from context instead of claiming a dispatch
 *     that the guard canceled. Delegation target fields are also cleared so no
 *     downstream reader mistakes the decision for a dispatchable delegation.
 *
 * Every other decision passes through untouched apart from the stamp.
 */
export function guardKernelRouteDecision<T extends KernelRouteDecision>(
	content: string,
	decision: T,
): T & { explicitDelegationIntent: boolean } {
	const acknowledgmentOnly = requestsAcknowledgmentOnly(content);
	const noDelegation = prohibitsDelegation(content);
	const explicitDelegationIntent =
		!acknowledgmentOnly &&
		!noDelegation &&
		hasExplicitDelegationIntent(content);
	if (
		acknowledgmentOnly ||
		(noDelegation &&
			(decision.routeKind === "delegate_tedi" ||
				decision.routeKind === "suggest_handoff" ||
				(decision.routeKind === "answer_in_home" &&
					!!decision.answer &&
					promisesDelegation(decision.answer))))
	) {
		return {
			...decision,
			routeKind: "answer_in_home",
			answer: acknowledgmentOnly
				? "Acknowledged."
				: "I’ll respond here without delegating.",
			rationale: `${decision.rationale} [kernel guard: operator requested a direct response without delegation]`,
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: null,
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
			explicitDelegationIntent: false,
		};
	}
	if (
		decision.routeKind === "delegate_tedi" &&
		!explicitDelegationIntent &&
		decision.risk === "low" &&
		(decision.effortClass === "single_read" || decision.effortClass === null) &&
		(decision.plannedToolIds?.length ?? 0) === 0 &&
		mentionsTedixInternalState(content) &&
		!requiresLiveConnectionState(content)
	) {
		const answer =
			decision.answer && promisesDelegation(decision.answer)
				? null
				: decision.answer;
		return {
			...decision,
			routeKind: "answer_in_home",
			answer,
			rationale: `${decision.rationale} [kernel guard: low-risk single read over Tedix-internal state with no explicit delegation intent — answered in Home]`,
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			explicitDelegationIntent,
		};
	}
	return { ...decision, explicitDelegationIntent };
}
