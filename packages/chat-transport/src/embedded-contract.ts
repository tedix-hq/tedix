/** Exact RPC signal: the stream was rejected before any adapter dispatch. */
export const EMBEDDED_STREAM_NOT_STARTED_EXPIRED =
	"Session expired before stream dispatch";

/**
 * Exact RPC signal: the `lastEventId` the client offered does not belong to
 * the run this turn resolves to.
 *
 * The capability derives the run id from the authority plus the client request
 * id and refuses any cursor outside it. The client matches on this exact
 * message to recognise a POISON resume seed — a watermark parked by an earlier
 * `stream()` invocation whose run no longer resolves — drop it, and re-open
 * cold instead of spending its retry budget re-offering the same bad cursor.
 */
export const EMBEDDED_STREAM_CURSOR_REJECTED =
	"Cursor does not belong to this conversation";

import type { RuntimeFrame } from "./runtime-frames";
import type { CapnConnection } from "./session-hub";
import type { ClientTurnMilestoneBatch } from "./client-turn-milestones";

export interface EmbeddedTurnInput {
	clientRequestId: string;
	text: string;
	pageContext?: unknown;
	lastEventId?: string;
	resume?: boolean;
	/**
	 * Canonical `provider/model-id` ref the user picked for this conversation.
	 *
	 * ADVISORY. The runtime edge re-validates it against the same model-catalog
	 * projection that built the picker's roster and ignores anything the tedi may
	 * not route at, so a forged ref from a browser can only ever cost the picker,
	 * never widen what the session may spend. Absent means the surface default.
	 */
	modelRef?: string;
	/**
	 * Thinking effort for this turn. Same advisory/re-validated contract as
	 * `modelRef`, and additionally dropped for a model the catalog says cannot
	 * take an effort on the wire.
	 */
	reasoningEffort?: string;
}
export interface EmbeddedSubscriber {
	(frame: RuntimeFrame): Promise<void>;
	dup?(): EmbeddedSubscriber;
	[Symbol.dispose]?(): void;
}
export interface EmbeddedPortableToolInput {
	callable: string;
	args: Record<string, unknown>;
}
export interface EmbeddedPortableToolDiscoveryInput {
	query: string;
	callables: string[];
}
export interface EmbeddedPortableToolRanking {
	rankedIds: string[] | null;
	/** Opaque billing join key from the same signed ranking call, including abstentions. */
	receipt: {
		executionId: string;
		usagePersistence: "persisted" | "unknown" | "failed";
	} | null;
}
export interface EmbeddedNamedCapability {
	id: string;
	capabilityId: string;
	replayName: string;
	name: string;
	slug: string;
	whyPresent: { type: string; actorId: string; attachedAt: string };
	authority: "context_only";
}
export interface EmbeddedCapabilityCatalogEntry {
	id: string;
	name: string;
	slug: string;
}
export interface EmbeddedConversationCapabilitySnapshot {
	attached: EmbeddedNamedCapability[];
	available: EmbeddedCapabilityCatalogEntry[];
	authority: "context_only";
}
export interface EmbeddedAttachCapabilityInput {
	capabilityId: string;
	replayName: string;
}
export interface EmbeddedArtifactPin {
	id: string;
	artifactId: string;
	replayName: string;
	revision: { algorithm: "sha256"; digest: string };
	artifact: {
		name: string;
		kind: string;
		mimeType: string | null;
		uri: string;
	};
	state: "active" | "stale";
	whyPresent: { type: string; actorId: string; attachedAt: string };
	authority: "context_only";
}
export interface EmbeddedAttachArtifactPinInput {
	artifactId: string;
	replayName: string;
}
export interface EmbeddedTranscript {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
}
export interface EmbeddedCompletedTurn {
	text: string;
}
export interface EmbeddedSessionApi {
	ping(): Promise<void>;
	/** Reads only this signed conversation; callers cannot select another key. */
	readTranscript(): Promise<EmbeddedTranscript>;
	/** Returns a durable completion only for this signed conversation and request. */
	readCompletedTurn(
		clientRequestId: string,
	): Promise<EmbeddedCompletedTurn | null>;
	stream(
		input: EmbeddedTurnInput,
		subscriber: EmbeddedSubscriber,
	): Promise<void>;
	cancel(clientRequestId: string): Promise<unknown>;
	listApprovals(): Promise<unknown>;
	requestApproval(description: string): Promise<unknown>;
	resolveApproval(id: string, approved: boolean): Promise<unknown>;
	pin(summary: string, pageContext?: unknown): Promise<unknown>;
	metrics(input: ClientTurnMilestoneBatch): Promise<void>;
	callPortableTool(input: EmbeddedPortableToolInput): Promise<unknown>;
	/** Advisory ordering of signed portable callables; never executes a tool. */
	rankPortableTools(
		input: EmbeddedPortableToolDiscoveryInput,
	): Promise<EmbeddedPortableToolRanking>;
	listConversationCapabilities(): Promise<EmbeddedConversationCapabilitySnapshot>;
	attachConversationCapability(
		input: EmbeddedAttachCapabilityInput,
	): Promise<{ capability: EmbeddedNamedCapability }>;
	detachConversationCapability(
		referenceId: string,
	): Promise<{ detached: true; referenceId: string }>;
	listConversationArtifactPins(): Promise<{ pins: EmbeddedArtifactPin[] }>;
	attachConversationArtifactPin(
		input: EmbeddedAttachArtifactPinInput,
	): Promise<{ pin: EmbeddedArtifactPin }>;
	detachConversationArtifactPin(
		pinId: string,
	): Promise<{ detached: true; pinId: string }>;
	[Symbol.dispose](): void;
}
export interface EmbeddedRootApi {
	authenticate(token: string): Promise<EmbeddedSessionApi>;
	[Symbol.dispose](): void;
}
export type EmbeddedSessionStub = Omit<
	EmbeddedSessionApi,
	typeof Symbol.dispose
> &
	CapnConnection;
