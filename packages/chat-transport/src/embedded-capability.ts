import {
	EMBEDDED_STREAM_CURSOR_REJECTED,
	EMBEDDED_STREAM_NOT_STARTED_EXPIRED,
} from "./embedded-contract";
import { RpcTarget } from "capnweb";
import type {
	EmbeddedArtifactPin,
	EmbeddedAttachArtifactPinInput,
	EmbeddedAttachCapabilityInput,
	EmbeddedConversationCapabilitySnapshot,
	EmbeddedNamedCapability,
	EmbeddedRootApi,
	EmbeddedSessionApi,
	EmbeddedSubscriber,
	EmbeddedTurnInput,
	EmbeddedTranscript,
	EmbeddedCompletedTurn,
	EmbeddedPortableToolInput,
	EmbeddedPortableToolDiscoveryInput,
	EmbeddedPortableToolRanking,
} from "./embedded-contract";
import {
	createEmbeddedStreamTiming,
	type EmbeddedStreamTiming,
} from "./embedded-stream-timing";
import { createFrameDeliveryWindow } from "./frame-delivery-window";
import { consumeRuntimeFrames } from "./runtime-frames";
import {
	type ClientTurnMilestoneBatch,
	validateClientTurnMilestoneBatch,
} from "./client-turn-milestones";

/** Adapter-owned authorization. None of these values come from browser inputs. */
export interface EmbeddedAuthority {
	sessionKey: string;
	subject: string;
	tenant: string;
	origin: string;
	expiresAt: number;
}
export interface EmbeddedCapabilityAdapter {
	observeStream?(timing: EmbeddedStreamTiming): void;
	authorize(token: string): Promise<EmbeddedAuthority>;
	readTranscript(
		token: string,
		signal: AbortSignal,
	): Promise<EmbeddedTranscript>;
	readCompletedTurn?(
		token: string,
		input: { runId: string },
		signal: AbortSignal,
	): Promise<EmbeddedCompletedTurn | null>;
	stream(
		token: string,
		input: {
			runId: string;
			turnKey: string;
			text: string;
			pageContext?: unknown;
			lastEventId?: string;
			resume: boolean;
			modelRef?: string;
			reasoningEffort?: string;
			signal: AbortSignal;
		},
	): Promise<Response>;
	cancel(token: string, turnKey: string, signal: AbortSignal): Promise<unknown>;
	listApprovals(token: string, signal: AbortSignal): Promise<unknown>;
	requestApproval(
		token: string,
		description: string,
		signal: AbortSignal,
	): Promise<unknown>;
	resolveApproval(
		token: string,
		id: string,
		approved: boolean,
		signal: AbortSignal,
	): Promise<unknown>;
	pin(
		token: string,
		summary: string,
		pageContext: unknown,
		signal: AbortSignal,
	): Promise<unknown>;
	metrics(
		token: string,
		input: ClientTurnMilestoneBatch & { runId: string; traceId: string },
		signal: AbortSignal,
	): Promise<void>;
	callPortableTool(
		token: string,
		input: EmbeddedPortableToolInput,
		signal: AbortSignal,
	): Promise<unknown>;
	rankPortableTools(
		token: string,
		input: EmbeddedPortableToolDiscoveryInput,
		signal: AbortSignal,
	): Promise<EmbeddedPortableToolRanking>;
	listConversationCapabilities(
		token: string,
		signal: AbortSignal,
	): Promise<EmbeddedConversationCapabilitySnapshot>;
	attachConversationCapability(
		token: string,
		input: EmbeddedAttachCapabilityInput,
		signal: AbortSignal,
	): Promise<{ capability: EmbeddedNamedCapability }>;
	detachConversationCapability(
		token: string,
		referenceId: string,
		signal: AbortSignal,
	): Promise<{ detached: true; referenceId: string }>;
	listConversationArtifactPins(
		token: string,
		signal: AbortSignal,
	): Promise<{ pins: EmbeddedArtifactPin[] }>;
	attachConversationArtifactPin(
		token: string,
		input: EmbeddedAttachArtifactPinInput,
		signal: AbortSignal,
	): Promise<{ pin: EmbeddedArtifactPin }>;
	detachConversationArtifactPin(
		token: string,
		pinId: string,
		signal: AbortSignal,
	): Promise<{ detached: true; pinId: string }>;
	runId(turnKey: string): string;
}

export async function scopedTurnKey(
	authority: EmbeddedAuthority,
	clientRequestId: string,
): Promise<string> {
	if (!/^[a-zA-Z0-9_-]{8,128}$/.test(clientRequestId))
		throw new Error("Invalid request id");
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			authority.tenant,
			authority.origin,
			authority.subject,
			authority.sessionKey,
			clientRequestId,
		]),
	);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * How long an IN-FLIGHT stream may keep delivering frames past the
 * credential's `expiresAt`. New operations still refuse at `expiresAt`
 * exactly; only a turn that was already authorized and is still producing
 * frames rides the grace window. Without it a turn longer than the token TTL
 * (10 min for embedded sessions) had its `done` frame dropped mid-answer.
 */
export const EMBEDDED_STREAM_EXPIRY_GRACE_MS = 60_000;

/** The exact message the client keys its credential refresh on. */
export const EMBEDDED_SESSION_EXPIRED_MESSAGE = "Session expired";

/** One capability per verified embedded conversation, not ambient tenant access. */
export class EmbeddedSession extends RpcTarget implements EmbeddedSessionApi {
	#adapter: EmbeddedCapabilityAdapter;
	#token: string;
	#authority: EmbeddedAuthority;
	#disposed = false;
	#abort = new AbortController();
	#expiry: ReturnType<typeof setTimeout>;
	#streaming = false;
	#window = Date.now();
	#calls = 0;
	#now: () => number;
	#graceMs: number;

	constructor(
		adapter: EmbeddedCapabilityAdapter,
		token: string,
		authority: EmbeddedAuthority,
		options: { now?: () => number; streamGraceMs?: number } = {},
	) {
		super();
		this.#adapter = adapter;
		this.#token = token;
		this.#authority = authority;
		this.#now = options.now ?? Date.now;
		this.#graceMs = options.streamGraceMs ?? EMBEDDED_STREAM_EXPIRY_GRACE_MS;
		this.#expiry = setTimeout(
			() => this.#onExpiry(),
			Math.max(0, authority.expiresAt - this.#now()),
		);
	}

	/** Absolute deadline after which even an in-flight stream is cut. */
	get #hardDeadline(): number {
		return this.#authority.expiresAt + this.#graceMs;
	}

	#onExpiry(): void {
		// A stream that is still delivering frames keeps its capability alive for
		// the grace window; disposal would abort the runtime fetch and lose the
		// terminal frame. Everything else disposes at `expiresAt` as before.
		if (this.#streaming && this.#now() < this.#hardDeadline) {
			this.#expiry = setTimeout(
				() => this[Symbol.dispose](),
				Math.max(0, this.#hardDeadline - this.#now()),
			);
			return;
		}
		this[Symbol.dispose]();
	}

	/**
	 * One re-authorization at expiry. The adapter decides whether the token is
	 * still acceptable (clock tolerance, a rotated credential); a longer
	 * `expiresAt` extends the session, anything else leaves the grace window as
	 * the only remaining budget. Never throws.
	 */
	async #reauthorizeAtExpiry(): Promise<boolean> {
		try {
			const current = await this.#adapter.authorize(this.#token);
			if (
				current.sessionKey !== this.#authority.sessionKey ||
				current.subject !== this.#authority.subject ||
				current.tenant !== this.#authority.tenant ||
				current.origin !== this.#authority.origin ||
				current.expiresAt <= this.#authority.expiresAt
			) {
				return false;
			}
			this.#authority = current;
			clearTimeout(this.#expiry);
			this.#expiry = setTimeout(
				() => this.#onExpiry(),
				Math.max(0, current.expiresAt - this.#now()),
			);
			return true;
		} catch {
			return false;
		}
	}

	async #check(): Promise<void> {
		if (this.#disposed || this.#now() >= this.#authority.expiresAt)
			throw new Error(EMBEDDED_SESSION_EXPIRED_MESSAGE);
		if (Date.now() - this.#window >= 10_000) {
			this.#window = Date.now();
			this.#calls = 0;
		}
		if (++this.#calls > 30) throw new Error("Session rate limit");
		const current = await this.#adapter.authorize(this.#token);
		if (
			current.sessionKey !== this.#authority.sessionKey ||
			current.subject !== this.#authority.subject ||
			current.tenant !== this.#authority.tenant ||
			current.origin !== this.#authority.origin
		) {
			this[Symbol.dispose]();
			throw new Error("Session identity changed");
		}
	}

	async ping(): Promise<void> {
		await this.#check();
	}
	async readTranscript(): Promise<EmbeddedTranscript> {
		await this.#check();
		return this.#adapter.readTranscript(this.#token, this.#abort.signal);
	}
	async readCompletedTurn(
		clientRequestId: string,
	): Promise<EmbeddedCompletedTurn | null> {
		await this.#check();
		const turnKey = await scopedTurnKey(this.#authority, clientRequestId);
		if (!this.#adapter.readCompletedTurn) return null;
		return this.#adapter.readCompletedTurn(
			this.#token,
			{ runId: this.#adapter.runId(turnKey) },
			this.#abort.signal,
		);
	}
	async stream(
		input: EmbeddedTurnInput,
		subscriber: EmbeddedSubscriber,
	): Promise<void> {
		const timing = createEmbeddedStreamTiming(this.#now);
		try {
			await this.#check();
			timing.mark("authorized");
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === EMBEDDED_SESSION_EXPIRED_MESSAGE
			)
				throw new Error(EMBEDDED_STREAM_NOT_STARTED_EXPIRED);
			throw error;
		}
		if (this.#streaming) throw new Error("A stream is already active");
		// Claim the single subscription before the first async validation. Without
		// this, two concurrent RPCs can both pass the guard and fan out one
		// conversation through the same capability.
		this.#streaming = true;
		const retained = subscriber.dup?.() ?? subscriber;
		const delivery = createFrameDeliveryWindow<
			Parameters<EmbeddedSubscriber>[0]
		>((frame) => timing.deliver(frame, () => Promise.resolve(retained(frame))));
		let observedRunId: string | undefined;
		let outcome: EmbeddedStreamTiming["outcome"] = "failed";
		try {
			if (
				!input ||
				typeof input.text !== "string" ||
				input.text.length > 32_000
			)
				throw new Error("Invalid message");
			const turnKey = await scopedTurnKey(
				this.#authority,
				input.clientRequestId,
			);
			const runId = this.#adapter.runId(turnKey);
			observedRunId = runId;
			if (
				input.lastEventId &&
				(!input.lastEventId.startsWith(runId + ":") ||
					!/^\d+$/.test(input.lastEventId.slice(runId.length + 1)))
			) {
				throw new Error(EMBEDDED_STREAM_CURSOR_REJECTED);
			}
			// Shape-check only. What a caller may actually route at is decided by
			// the adapter against the model catalog, never here and never by the
			// browser: this boundary just refuses values that cannot be a ref or an
			// effort so malformed input fails before it reaches an internal request.
			const modelRef =
				typeof input.modelRef === "string" &&
				/^[a-z0-9-]+\/[\w./@-]{1,120}$/i.test(input.modelRef)
					? input.modelRef
					: undefined;
			const reasoningEffort =
				typeof input.reasoningEffort === "string" &&
				/^(none|low|medium|high)$/.test(input.reasoningEffort)
					? input.reasoningEffort
					: undefined;
			const response = await this.#adapter.stream(this.#token, {
				runId,
				turnKey,
				text: input.text,
				pageContext: input.pageContext,
				lastEventId: input.lastEventId,
				resume: input.resume === true,
				...(modelRef ? { modelRef } : {}),
				...(reasoningEffort ? { reasoningEffort } : {}),
				signal: this.#abort.signal,
			});
			timing.mark("response");
			let reauthorized = false;
			await consumeRuntimeFrames(response, async (frame) => {
				timing.receive(frame);
				if (this.#disposed) throw new Error(EMBEDDED_SESSION_EXPIRED_MESSAGE);
				if (this.#now() >= this.#authority.expiresAt) {
					if (!reauthorized) {
						reauthorized = true;
						await this.#reauthorizeAtExpiry();
					}
					// Past `expiresAt` but inside the grace window: keep delivering.
					// The client refreshes its credential and resumes by cursor if
					// this stream ends before `done`.
					if (this.#now() >= this.#hardDeadline)
						throw new Error(EMBEDDED_SESSION_EXPIRED_MESSAGE);
				}
				await delivery.send(frame);
				if (frame.event.kind === "done") outcome = "completed";
			});
		} catch (error) {
			outcome = "failed";
			throw error;
		} finally {
			try {
				await delivery.drain();
				timing.mark("drained");
			} catch (error) {
				outcome = "failed";
				throw error;
			} finally {
				retained[Symbol.dispose]?.();
				this.#streaming = false;
				if (observedRunId) {
					try {
						this.#adapter.observeStream?.(
							timing.snapshot(observedRunId, input.resume === true, outcome),
						);
					} catch {
						/* Diagnostics must not change delivery. */
					}
				}
			}
		}
	}
	async cancel(clientRequestId: string): Promise<unknown> {
		await this.#check();
		const turnKey = await scopedTurnKey(this.#authority, clientRequestId);
		return this.#adapter.cancel(this.#token, turnKey, this.#abort.signal);
	}
	async listApprovals(): Promise<unknown> {
		await this.#check();
		return this.#adapter.listApprovals(this.#token, this.#abort.signal);
	}
	async requestApproval(description: string): Promise<unknown> {
		if (
			typeof description !== "string" ||
			!description.trim() ||
			description.length > 2_000
		)
			throw new Error("Invalid approval request");
		await this.#check();
		return this.#adapter.requestApproval(
			this.#token,
			description.trim(),
			this.#abort.signal,
		);
	}
	async resolveApproval(id: string, approved: boolean): Promise<unknown> {
		if (!/^[0-9a-f-]{36}$/i.test(id) || typeof approved !== "boolean")
			throw new Error("Invalid approval");
		await this.#check();
		return this.#adapter.resolveApproval(
			this.#token,
			id,
			approved,
			this.#abort.signal,
		);
	}
	async pin(summary: string, pageContext?: unknown): Promise<unknown> {
		if (typeof summary !== "string" || summary.length > 20_000)
			throw new Error("Invalid summary");
		await this.#check();
		return this.#adapter.pin(
			this.#token,
			summary,
			pageContext,
			this.#abort.signal,
		);
	}
	async metrics(input: ClientTurnMilestoneBatch): Promise<void> {
		const batch = validateClientTurnMilestoneBatch(input);
		await this.#check();
		const turnKey = await scopedTurnKey(this.#authority, batch.clientRequestId);
		const runId = this.#adapter.runId(turnKey);
		return this.#adapter.metrics(
			this.#token,
			{ ...batch, runId, traceId: runId },
			this.#abort.signal,
		);
	}
	async callPortableTool(input: EmbeddedPortableToolInput): Promise<unknown> {
		if (
			!input ||
			typeof input.callable !== "string" ||
			!/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/.test(input.callable) ||
			!input.args ||
			typeof input.args !== "object" ||
			Array.isArray(input.args) ||
			JSON.stringify(input.args).length > 32_000
		) {
			throw new Error("Invalid portable tool call");
		}
		await this.#check();
		return this.#adapter.callPortableTool(
			this.#token,
			input,
			this.#abort.signal,
		);
	}
	async rankPortableTools(
		input: EmbeddedPortableToolDiscoveryInput,
	): Promise<EmbeddedPortableToolRanking> {
		const callable = /^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/;
		if (
			!input ||
			typeof input.query !== "string" ||
			input.query.trim().length < 3 ||
			input.query.length > 2_000 ||
			!Array.isArray(input.callables) ||
			input.callables.length < 2 ||
			input.callables.length > 12 ||
			input.callables.some(
				(name) => typeof name !== "string" || !callable.test(name),
			) ||
			new Set(input.callables).size !== input.callables.length
		)
			throw new Error("Invalid portable tool discovery");
		await this.#check();
		return this.#adapter.rankPortableTools(
			this.#token,
			{ query: input.query.trim(), callables: input.callables },
			this.#abort.signal,
		);
	}
	async listConversationCapabilities(): Promise<EmbeddedConversationCapabilitySnapshot> {
		await this.#check();
		return this.#adapter.listConversationCapabilities(
			this.#token,
			this.#abort.signal,
		);
	}
	async attachConversationCapability(
		input: EmbeddedAttachCapabilityInput,
	): Promise<{ capability: EmbeddedNamedCapability }> {
		if (
			!input ||
			!/^[0-9a-f-]{36}$/i.test(input.capabilityId) ||
			!/^[a-z][a-z0-9_]{0,63}$/.test(input.replayName)
		) {
			throw new Error("Invalid conversation capability");
		}
		await this.#check();
		return this.#adapter.attachConversationCapability(
			this.#token,
			input,
			this.#abort.signal,
		);
	}
	async detachConversationCapability(
		referenceId: string,
	): Promise<{ detached: true; referenceId: string }> {
		if (!/^[0-9a-f-]{36}$/i.test(referenceId)) {
			throw new Error("Invalid conversation capability reference");
		}
		await this.#check();
		return this.#adapter.detachConversationCapability(
			this.#token,
			referenceId,
			this.#abort.signal,
		);
	}
	async listConversationArtifactPins(): Promise<{
		pins: EmbeddedArtifactPin[];
	}> {
		await this.#check();
		return this.#adapter.listConversationArtifactPins(
			this.#token,
			this.#abort.signal,
		);
	}
	async attachConversationArtifactPin(
		input: EmbeddedAttachArtifactPinInput,
	): Promise<{ pin: EmbeddedArtifactPin }> {
		if (
			!input ||
			typeof input.artifactId !== "string" ||
			input.artifactId.length < 1 ||
			input.artifactId.length > 200 ||
			!/^[a-z][a-z0-9_]{0,63}$/.test(input.replayName)
		) {
			throw new Error("Invalid conversation artifact pin");
		}
		await this.#check();
		return this.#adapter.attachConversationArtifactPin(
			this.#token,
			input,
			this.#abort.signal,
		);
	}
	async detachConversationArtifactPin(
		pinId: string,
	): Promise<{ detached: true; pinId: string }> {
		if (!/^[0-9a-f-]{36}$/i.test(pinId)) {
			throw new Error("Invalid conversation artifact pin reference");
		}
		await this.#check();
		return this.#adapter.detachConversationArtifactPin(
			this.#token,
			pinId,
			this.#abort.signal,
		);
	}
	[Symbol.dispose](): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#expiry);
		this.#abort.abort();
	}
}

/** The unauthenticated root exposes no data or operations. */
export class EmbeddedRoot extends RpcTarget implements EmbeddedRootApi {
	#adapter: EmbeddedCapabilityAdapter;
	#session: EmbeddedSession | null = null;
	#authenticating = false;
	#disposed = false;
	#deadline = setTimeout(() => this[Symbol.dispose](), 10_000);
	constructor(adapter: EmbeddedCapabilityAdapter) {
		super();
		this.#adapter = adapter;
	}
	async authenticate(token: string): Promise<EmbeddedSession> {
		if (this.#disposed || this.#authenticating || this.#session)
			throw new Error("Authentication unavailable");
		if (typeof token !== "string" || token.length > 16_384)
			throw new Error("Invalid credential");
		this.#authenticating = true;
		try {
			const authority = await this.#adapter.authorize(token);
			if (this.#disposed || authority.expiresAt <= Date.now())
				throw new Error(EMBEDDED_SESSION_EXPIRED_MESSAGE);
			clearTimeout(this.#deadline);
			this.#session = new EmbeddedSession(this.#adapter, token, authority);
			return this.#session;
		} catch (error) {
			this[Symbol.dispose]();
			throw error;
		}
	}
	[Symbol.dispose](): void {
		this.#disposed = true;
		clearTimeout(this.#deadline);
		this.#session?.[Symbol.dispose]();
	}
}
