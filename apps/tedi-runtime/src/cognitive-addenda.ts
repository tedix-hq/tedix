/**
 * Shared cognitive addenda for ordinary Tedi turns. The context catalog owns
 * selection and output order. Independent sources build concurrently; skill
 * retrieval waits for skill guidance to warm its corpus. Lean verification and
 * synthesis turns consult no cognitive sources. Reports contain counts, status
 * and durations, never source text.
 */

import { logTediContextFailure } from "./context-failure-log";
import { isLeanContextSession } from "@tedix/api-contract/utils/runtime-identity";
import {
	classifyContextTurn,
	CONTEXT_SEGMENT_IDS,
	contextSegmentDefinition,
	type ContextSegmentId,
	contextSegmentsForTurn,
} from "@tedix/context-core/context-catalog";
import {
	measurePromptComposition,
	type PromptCompositionReport,
	type PromptSegment,
} from "@tedix/context-core/prompt-composition";

/**
 * Lazily-invoked producers for the four addenda blocks. Functions, not strings:
 * a blind session must never CALL them (each one reads durable cognitive state).
 */
export interface CognitiveAddendaSources {
	/** Compiled directives matching this turn's user text. */
	directives: () => Promise<string>;
	/** Cached top-K brain digest — the tedi's accumulated beliefs. */
	brainDigest: () => Promise<string>;
	/** Per-turn skill guidance summaries. */
	skillGuidance: () => Promise<string>;
	/**
	 * Act-time retrieved skills — top-K proven procedures matched against this
	 * turn's task text (AWM/Memp retrieve leg). Operational guidance like
	 * `skillGuidance`, so Home delegation work orders keep it.
	 */
	retrievedSkills: () => Promise<string>;
}

const HOME_DELEGATION_WORK_ORDER_PREFIX = "[HOME DELEGATION WORK ORDER ";

/**
 * Home delegation envelopes are explicit, bounded operator work orders. They
 * keep tedi identity, personal memory, and operational skill guidance, but a
 * loosely matching learned preference must not redirect the work order.
 */
export function isHomeDelegationWorkOrder(userText: string): boolean {
	return userText.trimStart().startsWith(HOME_DELEGATION_WORK_ORDER_PREFIX);
}

/**
 * The block set and its order are the CATALOG's, not this module's — see
 * `@tedix/context-core/context-catalog`. `CognitiveAddendaSources` is keyed by
 * the same ids, and `context-catalog.test.ts` asserts the two cannot drift.
 */
type AddendumName = ContextSegmentId;

/**
 * Compose one turn's cognitive addenda block, or `""` when the turn is a lean
 * context turn — blind verification (evidence judge, must receive no
 * accumulated belief) or lean workflow synthesis (`workflow:synth:*`, a
 * self-contained summarization whose entire input rides in the prompt; the
 * ~22k-token addenda haul is pure cost).
 *
 * Fail-soft per block: one failing source never breaks the turn — the turn just
 * runs without that block, exactly as before this helper existed.
 */
export interface CognitiveCompositionReport extends PromptCompositionReport {
	runId: string | null;
	durationMs: number;
	blocks: Array<{
		name: AddendumName;
		status: "included" | "empty" | "failed" | "withheld";
		durationMs: number;
		reason: string | null;
	}>;
}

export async function composeCognitiveAddenda(input: {
	/** Session key of the turn. `evidence:judge:*` / `workflow:synth:*` ⇒ no addenda, no reads. */
	sessionKey: string | null | undefined;
	runId?: string | null;
	sources: CognitiveAddendaSources;
	/** Suppress learned preferences for an explicit delegated work order. */
	skipDirectives?: boolean;
	/** Fail-soft sink; defaults to a content-free structured failure event. */
	onError?: (block: AddendumName, error: unknown) => void;
	/**
	 * Model context window, when known — lets the composition report express each
	 * block as a share of the window rather than only of the addenda.
	 */
	contextWindowTokens?: number | null;
	/**
	 * Composition sink; defaults to a `tedi.context.addenda` console event. Reports
	 * SHAPE only — see `@tedix/context-core/prompt-composition` on why this is
	 * never a truncation signal.
	 */
	onComposition?: (report: CognitiveCompositionReport) => void;
}): Promise<string> {
	const started = performance.now();
	const onError =
		input.onError ??
		((block: AddendumName, error: unknown) => {
			logTediContextFailure("tedi.context.addendum_failed", error, { block });
		});
	const turnKind = classifyContextTurn({
		isLeanContextSession: isLeanContextSession(input.sessionKey),
		isHomeDelegationWorkOrder: input.skipDirectives === true,
	});
	const blocks = contextSegmentsForTurn(turnKind);
	type BuiltBlock = {
		text: string;
		status: "included" | "empty" | "failed";
		durationMs: number;
	};
	const readBlock = async (block: AddendumName): Promise<BuiltBlock> => {
		const before = performance.now();
		try {
			const text = (await input.sources[block]()) ?? "";
			return {
				text,
				status: text ? "included" : "empty",
				durationMs: Math.round(performance.now() - before),
			};
		} catch (error) {
			onError(block, error);
			return {
				text: "",
				status: "failed",
				durationMs: Math.round(performance.now() - before),
			};
		}
	};
	const pending = new Map<AddendumName, Promise<BuiltBlock>>();
	for (const block of blocks) {
		// Guidance can warm the retrieval corpus. Other producers are independent;
		// start them together, then assemble in the unchanged catalog order.
		const guidance =
			block === "retrievedSkills" ? pending.get("skillGuidance") : undefined;
		pending.set(
			block,
			guidance ? guidance.then(() => readBlock(block)) : readBlock(block),
		);
	}
	const built = await Promise.all(
		blocks.map(async (block) => [block, await pending.get(block)!] as const),
	);
	const byName = new Map(built);
	const segments: PromptSegment[] = built.map(([name, value]) => ({
		name,
		text: value.text,
	}));
	try {
		const report: CognitiveCompositionReport = {
			...measurePromptComposition(segments, {
				contextWindowTokens: input.contextWindowTokens ?? null,
			}),
			runId: input.runId ?? null,
			durationMs: Math.round(performance.now() - started),
			blocks: CONTEXT_SEGMENT_IDS.map((name) => {
				const result = byName.get(name);
				return {
					name,
					status: result?.status ?? "withheld",
					durationMs: result?.durationMs ?? 0,
					reason: result
						? null
						: (contextSegmentDefinition(name).withheldFrom.find(
								(rule) => rule.kind === turnKind,
							)?.because ?? "not_selected"),
				};
			}),
		};
		if (input.onComposition) input.onComposition(report);
		else console.log({ event: "tedi.context.addenda", ...report });
	} catch {
		/* Measurement must never affect the turn. */
	}
	return segments
		.map((segment) => segment.text)
		.filter(Boolean)
		.join("\n\n");
}
