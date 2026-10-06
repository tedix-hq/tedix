import type { ContextSegmentId } from "@tedix/context-core/context-catalog";
import { exceptionTopology } from "./exception-topology";

type ContextFailureEvent =
	| "tedi.context.addendum_failed"
	| "tedi.context.source_failed"
	| "tedi.observer.azure_fallback";

type ContextSource =
	| "directives"
	| "brain_digest"
	| "skill_guidance"
	| "skill_retrieval"
	| "memory_recall"
	| "corpus_audit"
	| "brain_bridge";

type ContextOperation =
	| "load"
	| "cache"
	| "build"
	| "refresh"
	| "touch"
	| "query"
	| "persist_influence"
	| "emit_influence"
	| "check_influence"
	| "compile"
	| "audit"
	| "execute"
	| "queue";

/** Context and model failures may contain prompts, retrieved facts or tokens. */
export function logTediContextFailure(
	event: ContextFailureEvent,
	error: unknown,
	fields:
		| { block?: ContextSegmentId }
		| {
				source: ContextSource;
				operation: ContextOperation;
		  } = {},
	level: "warn" | "error" = "warn",
): void {
	console[level]({
		component: "tedi-runtime-context",
		event,
		...fields,
		exception: exceptionTopology(error),
	});
}

/** Source and operation are fixed code-owned labels, never tenant values. */
export function logTediSourceFailure(
	source: ContextSource,
	operation: ContextOperation,
	error: unknown,
	level: "warn" | "error" = "warn",
): void {
	logTediContextFailure(
		"tedi.context.source_failed",
		error,
		{
			source,
			operation,
		},
		level,
	);
}
