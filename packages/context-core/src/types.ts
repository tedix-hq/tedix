/** Priority levels aligned with total-recall's emoji system */
export type ObservationPriority = "high" | "medium" | "low";

/** Observation types aligned with Tedix brain fact types */
export type ObservationType =
	| "decision"
	| "technical"
	| "preference"
	| "procedural"
	| "pattern"
	| "error"
	| "episode";

/** Entity type for named entity extraction */
export type EntityType =
	| "person"
	| "tool"
	| "service"
	| "api"
	| "organization"
	| "domain";

/** A named entity identified in an observation */
export interface ObservationEntity {
	name: string;
	type: EntityType;
}

/** A single structured observation extracted by the Observer */
export interface Observation {
	date: string;
	time: string;
	priority: ObservationPriority;
	type: ObservationType;
	content: string;
	details: string[];
	/** Explicit terminal result for completed episode observations. */
	outcomeStatus?: "success" | "failure" | "partial";
	/** Explicit date referenced in the content (e.g. a deadline, past event) */
	referencedDate?: string;
	/** Relative temporal expression from the original text (e.g. "yesterday", "last week") */
	relativeDate?: string;
	/** Named entities identified in this observation — used for knowledge graph entity creation */
	entities?: ObservationEntity[];
}

export type TaskIntentKind =
	| "candidate"
	| "follow_up"
	| "issue"
	| "blocker"
	| "deadline"
	| "delegation";

export type TaskIntentSource =
	| "conversation"
	| "tool_result"
	| "observer"
	| "memory";

export type TaskIntentStatusHint =
	| "open"
	| "in_progress"
	| "blocked"
	| "waiting"
	| "done";

/** Provider-agnostic task signal extracted from a conversation turn. */
export interface TaskIntent {
	title: string;
	kind: TaskIntentKind;
	source: TaskIntentSource;
	confidence: number;
	requiresConfirmation: boolean;
	evidence: string[];
	ownerHint?: string;
	projectHint?: string;
	dueHint?: string;
	deadlineHint?: string;
	statusHint?: TaskIntentStatusHint;
	externalProviderHint?: string;
	labels?: string[];
	idempotencyKey?: string;
}

/** The full observation block maintained in the context window */
export interface ObservationBlock {
	observations: Observation[];
	/** All tasks currently in progress — parallel-task aware */
	currentTasks?: string[];
	/** Provider-agnostic task candidates observed this turn. */
	taskIntents?: TaskIntent[];
	/** Suggested next response — continuity bridge for the agent */
	suggestedResponse?: string;
	tokenCount: number;
}

/** Result from the Observer LLM — observations + continuity fields */
export interface ObserverResult {
	observations: Observation[];
	currentTasks?: string[];
	taskIntents?: TaskIntent[];
	suggestedResponse?: string;
}

/** Result of a Reflector cycle */
export interface ReflectionResult {
	observations: Observation[];
	mergedCount: number;
	keptCount: number;
	tokensBefore: number;
	tokensAfter: number;
}
