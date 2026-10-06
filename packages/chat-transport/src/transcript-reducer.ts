/**
 * Framework-neutral conversation core: a pure reducer over the runtime frames
 * (`runtime-frames.ts`: phase / delta / chunk / done / error) that produces the
 * transcript model the embedded Tedi widget renders from
 * (`apps/widget/src/embed/embed.mjs`). Rendering, throttling, and DOM ownership
 * stay with the host; this module only decides what a turn *is*.
 *
 * Only the widget uses it today. Native OS chat builds its own turn model from
 * `RuntimeStreamEvent` in `apps/os/src/lib/conversation-stream.ts` and
 * `overlay-state.ts`, and shares only `runtime-frames`, `markdown`,
 * `composer-semantics`, `canonical-projection`, `session-hub` and
 * `client-turn-milestones` with this package.
 *
 * `chunk` frames carry the raw AI SDK UI-stream body (`tool-input-start`,
 * `tool-input-available`, `tool-output-available`, `tool-output-error`,
 * `reasoning-delta`, …). Text deltas arrive as first-class `delta` frames, so
 * `text-delta` chunks are ignored here to avoid double-appending.
 */

import {
	type ChatRuntimePhase,
	readChatRuntimePhase,
	readChatToolInputProgress,
} from "./runtime-frames";

/**
 * A customer-facing pair of words for one tool, authored by the tenant on
 * `app_tools.invocation_status` and delivered with the rest of the widget's
 * published configuration.
 *
 * `invoking` is present tense and shows while the tool runs; `invoked` is past
 * tense and shows once it has answered.
 */
export interface TenantToolLabel {
	invoking?: string;
	invoked?: string;
}

/** Tool id → the tenant's own words for it. */
export type TenantToolLabels = Record<string, TenantToolLabel>;

const MAX_LABEL = 64;

function readLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, MAX_LABEL) : null;
}

/**
 * The tenant's label for a tool, or nothing.
 *
 * There is deliberately NO fallback that prettifies a tool id. A humanized
 * label map covers the tools its author thought of and leaks the raw callable
 * for everything else — and every tool an embedded widget can reach is an MCP
 * tool, so "everything else" is the normal case, not the edge. When this
 * returns null the renderer keeps its generic product-language row, which says
 * less but never says a machine name.
 *
 * Matching is on the tool id only: an exact hit, else the last segment of a
 * namespaced callable (`acme.search_orders`, `acme__search_orders`), so
 * a tenant authors one label per tool and not one per gateway spelling.
 */
export function resolveToolLabel(
	labels: TenantToolLabels | undefined,
	toolName: string | undefined,
): TenantToolLabel | null {
	if (!labels || !toolName) return null;
	const candidate =
		labels[toolName] ?? labels[toolName.replace(/^.*(?:\.|__)/, "")];
	if (!candidate || typeof candidate !== "object") return null;
	const invoking = readLabel(candidate.invoking);
	const invoked = readLabel(candidate.invoked);
	if (!invoking && !invoked) return null;
	return {
		...(invoking ? { invoking } : {}),
		...(invoked ? { invoked } : {}),
	};
}

export type TranscriptActivityStatus = "running" | "completed" | "error";

export interface TranscriptActivity {
	/** Tool call id from the runtime, or a synthetic key when it is missing. */
	id: string;
	toolName: string;
	status: TranscriptActivityStatus;
	startedAt: number;
	finishedAt?: number;
	args?: unknown;
	result?: unknown;
	error?: string;
	/** Assistant text length when the activity started — groups adjacent tools. */
	textOffset: number;
	/**
	 * The tenant's past-tense words for this tool. Absent unless the tenant
	 * authored them; never derived from `toolName`.
	 */
	displayLabel?: string;
	/** The tenant's present-tense words, shown while the tool runs. */
	pendingLabel?: string;
	/**
	 * Whole code points of tool input streamed so far. Drives a typing
	 * indicator; the text it counts never reaches this model.
	 */
	inputChars?: number;
}

export interface TranscriptTurn {
	id: string;
	role: "user" | "assistant";
	text: string;
	activities: TranscriptActivity[];
	phase?: ChatRuntimePhase;
	phaseDetail?: string;
	reasoning?: string;
	finalized: boolean;
	error?: string;
	/** How the turn reached `finalized`. */
	finalizedBy?: "done" | "error" | "history";
	startedAt: number;
	/** Wall-clock time of the last frame that touched this turn. */
	lastFrameAt?: number;
}

export interface TranscriptState {
	conversationId: string | null;
	turns: TranscriptTurn[];
	/** Tenant-published tool labels. Configuration, so it survives a reset. */
	toolLabels: TenantToolLabels;
}

export type TranscriptAction =
	| { type: "reset"; conversationId?: string | null }
	| { type: "user"; id?: string; text: string; at?: number }
	| { type: "assistant_start"; id?: string; at?: number }
	| {
			type: "history";
			turns: Array<{
				id?: string;
				role: "user" | "assistant";
				text: string;
				activities?: TranscriptActivity[];
			}>;
	  }
	| { type: "frame"; event: Record<string, unknown>; at?: number }
	| { type: "fail"; message: string; at?: number };

export function createTranscriptState(
	conversationId: string | null = null,
	toolLabels: TenantToolLabels = {},
): TranscriptState {
	return { conversationId, turns: [], toolLabels };
}

let syntheticCounter = 0;
function syntheticId(prefix: string): string {
	syntheticCounter += 1;
	return `${prefix}-${syntheticCounter}`;
}

function lastAssistantTurn(state: TranscriptState): TranscriptTurn | null {
	for (let index = state.turns.length - 1; index >= 0; index -= 1) {
		const turn = state.turns[index]!;
		if (turn.role === "assistant") return turn;
	}
	return null;
}

function replaceTurn(
	state: TranscriptState,
	turn: TranscriptTurn,
): TranscriptState {
	return {
		...state,
		turns: state.turns.map((candidate) =>
			candidate.id === turn.id ? turn : candidate,
		),
	};
}

function parseChunkBody(body: unknown): Record<string, unknown> | null {
	if (body && typeof body === "object" && !Array.isArray(body))
		return body as Record<string, unknown>;
	if (typeof body !== "string") return null;
	try {
		const parsed: unknown = JSON.parse(body);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function applyChunk(
	turn: TranscriptTurn,
	chunk: Record<string, unknown>,
	at: number,
	labels: TenantToolLabels,
): TranscriptTurn {
	const type = typeof chunk.type === "string" ? chunk.type : "";
	if (type === "reasoning-delta" || type === "reasoning") {
		const delta =
			typeof chunk.delta === "string"
				? chunk.delta
				: typeof chunk.text === "string"
					? chunk.text
					: "";
		return delta
			? { ...turn, reasoning: `${turn.reasoning ?? ""}${delta}` }
			: turn;
	}
	if (!type.startsWith("tool-")) return turn;
	const toolCall =
		chunk.toolCall && typeof chunk.toolCall === "object"
			? (chunk.toolCall as Record<string, unknown>)
			: null;
	const id =
		(typeof chunk.toolCallId === "string" && chunk.toolCallId) ||
		(toolCall && typeof toolCall.id === "string" && toolCall.id) ||
		(typeof chunk.id === "string" && chunk.id) ||
		null;
	const toolName =
		(typeof chunk.toolName === "string" && chunk.toolName) ||
		(toolCall && typeof toolCall.toolName === "string" && toolCall.toolName) ||
		null;
	if (!id && !toolName) return turn;
	const key = id ?? `tool:${toolName}`;
	const existing =
		turn.activities.find((activity) => activity.id === key) ??
		(toolName
			? [...turn.activities]
					.reverse()
					.find(
						(activity) =>
							activity.toolName === toolName && activity.status === "running",
					)
			: undefined);
	const complete = /output-available|result|finish|completed/.test(type);
	const output = chunk.output ?? chunk.result;
	const result =
		output && typeof output === "object"
			? (output as Record<string, unknown>)
			: undefined;
	const evidence = result?.completionEvidence;
	const failed =
		/output-error|error/.test(type) ||
		(complete &&
			(result?.ok === false ||
				result?.isError === true ||
				(evidence !== null &&
					typeof evidence === "object" &&
					"status" in evidence &&
					evidence.status === "failed")));
	const args = chunk.input ?? chunk.args;
	const base: TranscriptActivity = existing ?? {
		id: key,
		toolName: toolName ?? "tool",
		status: "running",
		startedAt: at,
		textOffset: turn.text.length,
	};
	const label = resolveToolLabel(labels, toolName ?? base.toolName);
	const next: TranscriptActivity = {
		...base,
		...(toolName && base.toolName === "tool" ? { toolName } : {}),
		...(label?.invoked ? { displayLabel: label.invoked } : {}),
		...(label?.invoking ? { pendingLabel: label.invoking } : {}),
		...(args !== undefined ? { args } : {}),
		...(complete
			? {
					status: "completed" as const,
					finishedAt: at,
					...(output !== undefined ? { result: output } : {}),
				}
			: {}),
		...(failed
			? {
					status: "error" as const,
					finishedAt: at,
					error:
						typeof chunk.errorText === "string"
							? chunk.errorText
							: typeof chunk.error === "string"
								? chunk.error
								: "Tool failed",
				}
			: {}),
	};
	const activities = existing
		? turn.activities.map((activity) =>
				activity.id === existing.id ? next : activity,
			)
		: [...turn.activities, next];
	return { ...turn, activities };
}

/** Pure reducer. Never mutates `state`. */
export function reduceTranscript(
	state: TranscriptState,
	action: TranscriptAction,
): TranscriptState {
	const at =
		"at" in action && typeof action.at === "number" ? action.at : Date.now();
	switch (action.type) {
		case "reset":
			return createTranscriptState(
				action.conversationId ?? null,
				state.toolLabels,
			);
		case "user":
			return {
				...state,
				turns: [
					...state.turns,
					{
						id: action.id ?? syntheticId("user"),
						role: "user",
						text: action.text,
						activities: [],
						finalized: true,
						finalizedBy: "history",
						startedAt: at,
					},
				],
			};
		case "assistant_start":
			return {
				...state,
				turns: [
					...state.turns,
					{
						id: action.id ?? syntheticId("assistant"),
						role: "assistant",
						text: "",
						activities: [],
						finalized: false,
						startedAt: at,
					},
				],
			};
		case "history":
			return {
				...state,
				turns: [
					...state.turns,
					...action.turns.map((turn) => ({
						id: turn.id ?? syntheticId(turn.role),
						role: turn.role,
						text: turn.text,
						activities: turn.activities ?? [],
						finalized: true,
						finalizedBy: "history" as const,
						startedAt: at,
					})),
				],
			};
		case "frame": {
			const turn = lastAssistantTurn(state);
			if (!turn || turn.finalized) return state;
			const event = action.event;
			const phase = readChatRuntimePhase(event);
			if (phase) {
				return replaceTurn(state, {
					...turn,
					phase: phase.phase,
					...(phase.detail ? { phaseDetail: phase.detail } : {}),
					lastFrameAt: at,
				});
			}
			const inputProgress = readChatToolInputProgress(event);
			if (inputProgress) {
				return replaceTurn(state, {
					...turn,
					activities: turn.activities.map((activity) =>
						activity.id === inputProgress.toolCallId
							? { ...activity, inputChars: inputProgress.chars }
							: activity,
					),
					lastFrameAt: at,
				});
			}
			if (event.kind === "delta") {
				const text = typeof event.text === "string" ? event.text : "";
				return replaceTurn(state, {
					...turn,
					text: `${turn.text}${text}`,
					lastFrameAt: at,
				});
			}
			if (event.kind === "chunk") {
				const chunk = parseChunkBody(event.body);
				if (!chunk) return replaceTurn(state, { ...turn, lastFrameAt: at });
				return replaceTurn(state, {
					...applyChunk(turn, chunk, at, state.toolLabels),
					lastFrameAt: at,
				});
			}
			if (event.kind === "done") {
				const terminal = typeof event.text === "string" ? event.text : "";
				// A streamed answer can be longer than the terminal text when the
				// runtime truncates it; keep the longer prefix-consistent copy.
				const text =
					turn.text.length > terminal.length && turn.text.startsWith(terminal)
						? turn.text
						: terminal || turn.text;
				return replaceTurn(state, {
					...turn,
					text,
					activities: turn.activities.map((activity) =>
						activity.status === "running"
							? { ...activity, status: "completed", finishedAt: at }
							: activity,
					),
					finalized: true,
					finalizedBy: "done",
					phase: undefined,
					phaseDetail: undefined,
					lastFrameAt: at,
				});
			}
			if (event.kind === "error") {
				return replaceTurn(state, {
					...turn,
					finalized: true,
					finalizedBy: "error",
					error:
						typeof event.message === "string" ? event.message : "Turn failed",
					lastFrameAt: at,
				});
			}
			return replaceTurn(state, { ...turn, lastFrameAt: at });
		}
		case "fail": {
			const turn = lastAssistantTurn(state);
			if (!turn || turn.finalized) return state;
			return replaceTurn(state, {
				...turn,
				finalized: true,
				finalizedBy: "error",
				error: action.message,
				activities: turn.activities.map((activity) =>
					activity.status === "running"
						? {
								...activity,
								status: "error",
								error: action.message,
								finishedAt: at,
							}
						: activity,
				),
				lastFrameAt: at,
			});
		}
		default:
			return state;
	}
}

/**
 * Milliseconds since the last frame touched the open assistant turn, or
 * `null` when no turn is streaming. Hosts use it to detect a missing `done`.
 */
export function openTurnIdleMs(
	state: TranscriptState,
	now = Date.now(),
): number | null {
	const turn = lastAssistantTurn(state);
	if (!turn || turn.finalized) return null;
	return Math.max(0, now - (turn.lastFrameAt ?? turn.startedAt));
}
