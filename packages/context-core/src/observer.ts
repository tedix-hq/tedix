/**
 * Observer — pure parse/validate helpers for structured output from the
 * Observer LLM. No HTTP, no platform-client dependencies. The runtime
 * (Agent runtime or brain-bridge) supplies the LLM
 * call and feeds raw JSON content into `parseObserverResult`.
 */

import type { Observation, ObserverResult, TaskIntent } from "./types.js";

const TASK_INTENT_KINDS = new Set([
	"candidate",
	"follow_up",
	"issue",
	"blocker",
	"deadline",
	"delegation",
]);
const TASK_INTENT_SOURCES = new Set([
	"conversation",
	"tool_result",
	"observer",
	"memory",
]);
const TASK_STATUS_HINTS = new Set([
	"open",
	"in_progress",
	"blocked",
	"waiting",
	"done",
]);

const VALID_ENTITY_TYPES = new Set([
	"person",
	"tool",
	"service",
	"api",
	"organization",
	"domain",
]);
const EPISODE_OUTCOME_STATUSES = new Set(["success", "failure", "partial"]);

function cleanStringArray(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.slice(0, maxItems);
}

// ── Self-owner guard ────────────────────────────────────────────────────────
// A model may label a taskIntent's ownerHint with a first-person token ("self",
// "me", "I'll …") when the assistant talks about its own next step. Only a
// GENUINE first-person commitment to a concrete, scoped deliverable should
// survive as the sentinel ownerHint="self" (which the downstream commitment gate
// treats as actionable). Procedural / monitoring / tool-invocation self-talk has
// its self-owner STRIPPED — it then degrades to working memory via the unchanged
// commitment gate, exactly as it does today. We strip (not throw) so a mislabel
// degrades gracefully; the prompt is the recall source, this is the hard line.

/** Owner tokens that mean "the speaker/assistant itself". */
const SELF_OWNER_TOKENS = new Set(["self", "me", "myself", "i"]);

/** Leading first-person commitment markers ("I'll …", "let me …", "going to …"). */
const COMMITMENT_MARKER_PATTERN =
	/^(?:i['’]ll|i\s+will|i['’]?m\s+going\s+to|i\s+am\s+going\s+to|i\s+plan\s+to|let\s+me|going\s+to)\b/i;

/** Concrete state-changing build/change verbs that name a real deliverable. */
const BUILD_VERBS = [
	"refactor",
	"implement",
	"build",
	"write",
	"fix",
	"migrate",
	"add",
	"create",
	"ship",
	"draft",
	"design",
	"rewrite",
	"rename",
	"remove",
	"wire",
	"integrate",
	"document",
	"update",
];
const BUILD_VERB_PATTERN = new RegExp(
	`\\b(?:${BUILD_VERBS.join("|")})\\b`,
	"i",
);

/** Monitoring / inspection / routing verbs — procedural, never an owned deliverable. */
const PROCEDURAL_LEADING_VERBS = [
	"run",
	"inspect",
	"verify",
	"check",
	"monitor",
	"watch",
	"poll",
	"escalate",
	"notify",
	"report",
	"review",
	"investigate",
	"scan",
	"detect",
	"fetch",
	"tail",
];
const PROCEDURAL_LEADING_VERB_PATTERN = new RegExp(
	`^(?:${PROCEDURAL_LEADING_VERBS.join("|")})\\b`,
	"i",
);

/** Tool / command / script / MCP-route tokens — a procedural invocation, not a deliverable. */
const TOOL_OR_ROUTE_PATTERN =
	/\b(?:node|wrangler|npm|bun|git)\b|scripts\/|\.mjs\b|\.sh\b|\.\/|\/rpc\/|home\.ask|\b[a-z][a-z0-9]*_[a-z0-9_]*\(/i;

/** Conditional / contingent phrasing — not a firm commitment. */
const CONDITIONAL_PATTERN = /\bonce if\b|\bif a\b|\bwhen a\b|\bas needed\b/i;

/** True when an emitted ownerHint token refers to the speaker/assistant itself. */
function isSelfOwnerToken(value: string): boolean {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[.,;:!?]+$/, "");
	if (SELF_OWNER_TOKENS.has(normalized)) return true;
	return COMMITMENT_MARKER_PATTERN.test(normalized);
}

/**
 * True only for a genuine first-person commitment to a concrete, scoped
 * deliverable: a leading commitment marker, then a build/change verb, then a
 * named subject — AND none of the procedural/tool/conditional reject signals.
 */
function isGenuineSelfCommitment(title: string): boolean {
	const t = title.trim();
	if (!t) return false;
	// Reject: tool/command/route invocation or conditional/contingent phrasing.
	if (TOOL_OR_ROUTE_PATTERN.test(t)) return false;
	if (CONDITIONAL_PATTERN.test(t)) return false;
	// Positive: a leading first-person commitment marker.
	const marker = t.match(COMMITMENT_MARKER_PATTERN);
	if (!marker) return false;
	const action = t.slice(marker[0].length).trim();
	// Reject: the action verb is procedural (monitoring/inspection/routing).
	if (PROCEDURAL_LEADING_VERB_PATTERN.test(action)) return false;
	// Positive: a concrete build/change verb in the action.
	const verb = action.match(BUILD_VERB_PATTERN);
	if (!verb) return false;
	// Positive: a scoped subject — at least one token after the verb.
	const subject = action.slice((verb.index ?? 0) + verb[0].length).trim();
	return subject.split(/\s+/).filter(Boolean).length >= 1;
}

/**
 * Resolve the parser's ownerHint. A self-referential owner token canonicalizes
 * to the sentinel "self" ONLY for a genuine first-person concrete commitment;
 * otherwise it is stripped (degrade, never throw) so a mislabeled procedural
 * self-intent falls back to working memory via the unchanged commitment gate.
 * Non-self owners (e.g. "cto") pass through unchanged.
 */
function resolveOwnerHint(raw: unknown, title: string): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (isSelfOwnerToken(trimmed)) {
		return isGenuineSelfCommitment(title) ? "self" : undefined;
	}
	return trimmed;
}

export function parseTaskIntents(value: unknown): TaskIntent[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(entry): entry is Record<string, unknown> =>
				Boolean(entry) && typeof entry === "object",
		)
		.map((entry) => {
			const title = typeof entry.title === "string" ? entry.title.trim() : "";
			if (!title) return null;
			const confidence =
				typeof entry.confidence === "number" &&
				Number.isFinite(entry.confidence)
					? Math.max(0, Math.min(1, entry.confidence))
					: 0.5;
			const intent: TaskIntent = {
				title,
				kind:
					typeof entry.kind === "string" && TASK_INTENT_KINDS.has(entry.kind)
						? (entry.kind as TaskIntent["kind"])
						: "candidate",
				source:
					typeof entry.source === "string" &&
					TASK_INTENT_SOURCES.has(entry.source)
						? (entry.source as TaskIntent["source"])
						: "observer",
				confidence,
				requiresConfirmation: entry.requiresConfirmation !== false,
				evidence: cleanStringArray(entry.evidence, 3),
				ownerHint: resolveOwnerHint(entry.ownerHint, title),
				projectHint:
					typeof entry.projectHint === "string"
						? entry.projectHint.trim()
						: undefined,
				dueHint:
					typeof entry.dueHint === "string" ? entry.dueHint.trim() : undefined,
				deadlineHint:
					typeof entry.deadlineHint === "string"
						? entry.deadlineHint.trim()
						: undefined,
				statusHint:
					typeof entry.statusHint === "string" &&
					TASK_STATUS_HINTS.has(entry.statusHint)
						? (entry.statusHint as TaskIntent["statusHint"])
						: undefined,
				externalProviderHint:
					typeof entry.externalProviderHint === "string"
						? entry.externalProviderHint.trim()
						: undefined,
				labels: cleanStringArray(entry.labels, 8),
			};
			return intent;
		})
		.filter((entry): entry is TaskIntent => entry !== null)
		.slice(0, 5);
}

/**
 * Parse and validate the raw JSON content returned by an Observer LLM call
 * into an `ObserverResult`. Returns `{ observations: [] }` if the content is
 * malformed. No exceptions are thrown.
 */
export function parseObserverResult(content: string): ObserverResult {
	const empty: ObserverResult = { observations: [] };

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return empty;
	}

	if (!parsed || typeof parsed !== "object") return empty;
	const p = parsed as Record<string, unknown>;

	const arr: unknown[] = Array.isArray(parsed)
		? (parsed as unknown[])
		: Array.isArray(p.observations)
			? (p.observations as unknown[])
			: typeof p.content === "string" && typeof p.priority === "string"
				? [parsed]
				: [];

	const observations = arr
		.filter(
			(o): o is Record<string, unknown> =>
				Boolean(o) &&
				typeof o === "object" &&
				typeof (o as any).content === "string" &&
				typeof (o as any).priority === "string" &&
				typeof (o as any).type === "string",
		)
		.map((o) => {
			const obs = o as any;
			if (
				obs.type !== "episode" ||
				!EPISODE_OUTCOME_STATUSES.has(obs.outcomeStatus)
			) {
				delete obs.outcomeStatus;
			}
			if (Array.isArray(obs.entities)) {
				obs.entities = obs.entities.filter(
					(e: any) =>
						typeof e?.name === "string" &&
						e.name.trim() &&
						VALID_ENTITY_TYPES.has(e.type),
				);
				if (obs.entities.length === 0) delete obs.entities;
			} else {
				delete obs.entities;
			}
			return obs as Observation;
		});

	const currentTasks: string[] = Array.isArray(p.currentTasks)
		? (p.currentTasks as unknown[]).filter(
				(t): t is string => typeof t === "string" && t.trim().length > 0,
			)
		: [];
	const taskIntents = parseTaskIntents(p.taskIntents);

	return {
		observations,
		currentTasks: currentTasks.length > 0 ? currentTasks : undefined,
		taskIntents: taskIntents.length > 0 ? taskIntents : undefined,
		suggestedResponse:
			typeof p.suggestedResponse === "string" ? p.suggestedResponse : "",
	};
}
