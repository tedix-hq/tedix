import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import { deriveIdempotencyKey } from "@tedix/tedi-session/session-repo";
import type { AgentEmail } from "agents/email";
import { jsonSchema, tool, type ToolSet } from "ai";
import PostalMime from "postal-mime";
import { type NativeAcpTurnInput } from "./acp-channel";
import { adaptiveLearningModeForTurn } from "./adaptive-learning";
import { preparedTedixMcpAITools, tedixMcpAITools } from "./ai-sdk-adapter";
import type { RecentTurn } from "./bridge-turn-input";
import { createRuntimePhaseTracker } from "./chat-runtime-phase";
import { finalizeSuccessfulChatStream } from "./chat-stream-finalization";
import { type FrameSink } from "./chat-stream-hub";
import { resolveChatContext } from "./chat-stream-input";
import { createToolInputProgress } from "./chat-tool-input-progress";
import { computerWorkspaceScope } from "./computer-workspace-scope";
import { type FacetBudgetStopReason } from "./conversation-facet";
import type { ActiveTurnBinding, AgentTediDO } from "./do";
import { recordEmailRuntimeOutcome } from "./email-outcome-receipt";
import {
	AUTO_SUBMITTED_HEADER,
	AUTO_SUBMITTED_VALUE,
} from "./email-sender-policy";
import {
	emailTurnMemoryEffects,
	emailTurnSystemAddendum,
	type InboundEmailTrust,
	inboundEmailTrust,
	selectEmailTurnTools,
} from "./email-turn-tools";
import { embeddedToolFitGuidance } from "./embedded-tool-fit";
import { refuseOverEmbeddedTurnQuota } from "./embedded-turn-quota";
import {
	buildRunId,
	isEphemeralSession,
	mirrorTurnToLedger,
} from "./ledger-mirror";
import { cacheOrderedSystemPrompt } from "./prompt-cache";
import { CODE_MODE_BATCHING_NOTE } from "./runtime-facet-turns";
import { logTediRuntimeFailure } from "./runtime-failure-log";
import { WORKSPACE_TOOLS_NOTE } from "./runtime-tool-guidance";
import { parseLastEventId } from "./sse-resume";
import { type FacetTurnUsage } from "./step-telemetry";
import {
	selectTrustedTurnTools,
	trustedTurnMemoryEffects,
	untrustedTurnSystemAddendum,
	untrustedTurnToolAllowlist,
} from "./turn-trust";
import { wrapUntrustedInput } from "./untrusted-input";
export interface InboundEmailPayload {
	tediId: string;
	orgId: string;
	from: string;
	to: string;
	subject: string;
	textBody: string;
	htmlBody?: string;
	threadId: string;
	messageId: string;
	inReplyTo?: string;
	references?: string[];
	receivedAt?: string;
}

/**
 * Synthetic tool spec for the email-turn `reply_to_email` tool. Injected by
 * {@link AgentTediDO.completeEmailTurn} alongside the aggregator's MCP tools
 * — when the LLM calls it, the handler invokes `Agent.replyToEmail` (which
 * signs outbound headers with `EMAIL_SECRET` so the recipient's next reply
 * routes back to this exact DO instance via createSecureReplyEmailResolver
 * in email-ingress.ts). Stays scoped to email turns; chat turns never see it.
 */
function buildReplyToEmailToolSpec() {
	return {
		type: "function" as const,
		function: {
			name: "reply_to_email",
			description:
				"Reply in-thread to the inbound email that triggered this turn. " +
				"Uses Agent.replyToEmail() under the hood — preserves headers " +
				"(References/In-Reply-To), and signs an HMAC-protected reply token " +
				"so the recipient's next message routes back to this exact agent " +
				"instance. Prefer this over `email_send` for in-thread replies.",
			parameters: {
				type: "object",
				properties: {
					text: {
						type: "string",
						description: "Reply body (plain text).",
					},
					subject: {
						type: "string",
						description:
							"Optional reply subject. Defaults to `Re: <original subject>`.",
					},
				},
				required: ["text"],
				additionalProperties: false,
			},
		},
	};
}
export interface RuntimeChannelsHost {
	ensureIdentity: AgentTediDO["ensureIdentity"];
	state: AgentTediDO["state"];
	name: AgentTediDO["name"];
	sessionHarness: AgentTediDO["sessionHarness"];
	completeEmailTurn: AgentTediDO["completeEmailTurn"];
	ctx: AgentTediDO["ctx"];
	env: AgentTediDO["env"];
	queue: AgentTediDO["queue"];
	dispatchTurnMemoryEffects: AgentTediDO["dispatchTurnMemoryEffects"];
	enqueueCompaction: AgentTediDO["enqueueCompaction"];
	replyToEmail: AgentTediDO["replyToEmail"];
	getMcpRuntime: AgentTediDO["getMcpRuntime"];
	getPlatformClient: AgentTediDO["getPlatformClient"];
	workspaceAiTools: AgentTediDO["workspaceAiTools"];
	browserAiTools: AgentTediDO["browserAiTools"];
	skillReadTool: AgentTediDO["skillReadTool"];
	durableCodemodeAiTools: AgentTediDO["durableCodemodeAiTools"];
	cronAiTool: AgentTediDO["cronAiTool"];
	workstationAiTool: AgentTediDO["workstationAiTool"];
	objectStoreAiTools: AgentTediDO["objectStoreAiTools"];
	r2SqlAiTool: AgentTediDO["r2SqlAiTool"];
	runConversationFacetTurn: AgentTediDO["runConversationFacetTurn"];
	effectiveStepCeiling: AgentTediDO["effectiveStepCeiling"];
	acceptRuntimeTurn: AgentTediDO["acceptRuntimeTurn"];
	resolveAttachmentTurn: AgentTediDO["resolveAttachmentTurn"];
	chatStreamHub: AgentTediDO["chatStreamHub"];
	cognitiveAddenda: AgentTediDO["cognitiveAddenda"];
	activeTurnBinding: AgentTediDO["activeTurnBinding"];
	streamConversationFacetTurn: AgentTediDO["streamConversationFacetTurn"];
	clearActiveTurn: AgentTediDO["clearActiveTurn"];
	onLedgerMirror: AgentTediDO["onLedgerMirror"];
	runtimeAdmission: AgentTediDO["runtimeAdmission"];
	emitFailureTraceBundle: AgentTediDO["emitFailureTraceBundle"];
	mirrorFailedTurn: AgentTediDO["mirrorFailedTurn"];
	sseControllerSink: AgentTediDO["sseControllerSink"];
	sseFrameEncoder: AgentTediDO["sseFrameEncoder"];
}

export const runtimeChannels = {
	/**
	 * Agents SDK inbound email callback. Fires when `routeAgentEmail()` (called
	 * in email-ingress.ts) resolves a `{slug}@tedix.tech` recipient to this DO
	 * instance. The flow mirrors a chat turn — system prompt + recent turns +
	 * the email body — but channel-tagged so the ledger conversation stays
	 * distinct from Tedix OS chat:
	 *
	 *   conversationId = `email:{threadId}`
	 *
	 * Threading IDs come from the parsed message headers (Message-Id /
	 * In-Reply-To / References). The Agents SDK doesn't pass tediId/orgId so
	 * we hydrate identity via `this.state` and `this.name` (the slug-derived
	 * DO name). Reply correlation is handled by `signAgentHeaders` (outbound)
	 * + `createSecureReplyEmailResolver` (inbound) — see email-ingress.ts.
	 *
	 * Persists via:
	 *   - {@link mirrorTurnToLedger} → tedi_runtime_events (channel-tagged)
	 *   - {@link onBridgeTurn} → brain + rationale + artifact bridges
	 *   - {@link enqueueDailyLogPair} → daily-log CF Artifacts repo
	 *
	 * Fail-soft: any failure logs but does not throw — the durable mailbox row
	 * is already persisted by apps/api's tediEmail/inboundEmail handler before
	 * we get here, so this handler is best-effort for the agent reply path.
	 */
	async onEmail(this: RuntimeChannelsHost, email: AgentEmail): Promise<void> {
		const outcomeStartedAt = Date.now();
		await this.ensureIdentity({
			slug: this.state.slug || this.name || undefined,
		});
		// Parse the raw email body into structured text/html via postal-mime —
		// matches the example-email-agent reference. The SDK gives us from/to/
		// headers eagerly, but body content + Message-Id headers come from the
		// parsed MIME tree.
		const raw = await email.getRaw();
		const parsedMime = await PostalMime.parse(raw);
		const subject =
			parsedMime.subject?.trim() ||
			email.headers.get("subject") ||
			"(no subject)";
		const textBody = parsedMime.text?.trim() || "";
		const messageIdHeader = email.headers.get("message-id");
		const messageId =
			parsedMime.messageId || messageIdHeader || crypto.randomUUID();
		const inReplyTo = email.headers.get("in-reply-to") || undefined;
		const referencesHeader = email.headers.get("references") || "";
		const references = referencesHeader
			.split(/\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		// Thread correlation: prefer In-Reply-To (root of the conversation),
		// then the first References entry, then our own Message-Id (kicks off
		// a new thread). Matches the threadId apps/api computes for the
		// durable mailbox row.
		const threadId = inReplyTo || references[0] || messageId;

		const payload: InboundEmailPayload = {
			tediId: this.state.tediId,
			orgId: this.state.orgId,
			from: email.from,
			to: email.to,
			subject,
			textBody,
			htmlBody:
				typeof parsedMime.html === "string" ? parsedMime.html : undefined,
			threadId,
			messageId,
			inReplyTo,
			references,
			receivedAt: new Date().toISOString(),
		};

		// Thread headers are sender-written, so an unverified sender must never
		// select the conversation a verified correspondent's turns live on: its
		// turn runs on its own untrusted session for that thread, never hydrating
		// or appending to the trusted one. Decided here from the ingress stamp.
		const trust = inboundEmailTrust(email.headers);
		const sessionKey =
			trust === "trusted"
				? `email:${payload.threadId}`
				: `email:untrusted:${payload.threadId}`;
		const channelPreamble = [
			"[INBOUND EMAIL]",
			`From: ${payload.from}`,
			`To: ${payload.to}`,
			`Subject: ${payload.subject}`,
			`Thread-ID: ${payload.threadId}`,
			`Message-ID: ${payload.messageId}`,
			payload.inReplyTo ? `In-Reply-To: ${payload.inReplyTo}` : null,
			"---",
			payload.textBody,
			"[/INBOUND EMAIL]",
		]
			.filter(Boolean)
			.join("\n");

		const emailSystemAddendum = [
			"",
			"",
			"## Email Channel",
			`You are receiving this turn via the email channel (thread ${payload.threadId}).`,
			`Sender: ${payload.from}. Subject: ${payload.subject}.`,
			"To reply in-thread, call the `reply_to_email` tool with your reply text.",
			"This is the preferred reply path — it preserves the original thread for the",
			"sender and signs the outbound headers so their next message routes back to",
			"this exact agent instance.",
			"If you need to send an unrelated outbound email (different recipient, new",
			"thread), use `email_send` from the aggregator namespace instead.",
			"If no reply is required (notification, FYI, automated bounce, etc.), respond",
			"with a short acknowledgement only — passive receive is OK and you do not need",
			"to invoke any tool.",
		].join("\n");

		const userTurn: RecentTurn = {
			role: "user",
			content: channelPreamble,
			sessionKey,
			ts: Date.now(),
		};
		// Stage 3: key the email user turn on the deterministic `{runId}:0`. The
		// turnKey is the inbound MIME Message-ID (stable across redelivery), so a
		// re-delivered email dedups to the same runId and the user/assistant pair
		// shares it. `sanitizeTurnKey` strips the angle brackets in `buildRunId`.
		const emailRunId = buildRunId(this.state.tediId, messageId, "chat");
		await this.sessionHarness.appendTurn(
			sessionKey,
			userTurn,
			deriveIdempotencyKey(emailRunId, "user"),
		);

		// We need the email-channel system addendum on this turn only, so we
		// temporarily compose a system prompt without persisting it. Mirrors the
		// MCP runtime augmentation pattern shared by the chat paths.
		const baseSystemPrompt = this.state.systemPrompt;
		const augmentedSystem = `${baseSystemPrompt}${emailSystemAddendum}${emailTurnSystemAddendum(trust)}`;

		// The turn runs on the email conversation's own
		// ConversationFacet. History hydration is facet-owned (first-turn capped
		// harness render, same as the MCP/Tedix OS cutovers); the inbound body is
		// wrapped as untrusted for the MODEL only — harness/ledger keep the raw
		// preamble appended above, matching the MCP path's guard convention.
		let result: Awaited<ReturnType<typeof this.completeEmailTurn>>;
		try {
			result = await this.completeEmailTurn({
				guardedUserText: wrapUntrustedInput(channelPreamble, "email"),
				inboundEmail: email,
				payload,
				runId: emailRunId,
				sessionKey,
				system: augmentedSystem,
				trust,
				userTs: userTurn.ts,
			});
		} catch (error) {
			this.ctx.waitUntil(
				recordEmailRuntimeOutcome(this.env, {
					tediId: this.state.tediId,
					messageIdHeader,
					runId: emailRunId,
					result: "failed",
					elapsedMs: Date.now() - outcomeStartedAt,
					replied: null,
				}),
			);
			throw error;
		}
		const assistantTurn: RecentTurn = {
			role: "assistant",
			content: result.text,
			sessionKey,
			ts: Date.now(),
		};
		await this.sessionHarness.appendTurn(
			sessionKey,
			assistantTurn,
			deriveIdempotencyKey(emailRunId, "assistant"),
		);
		this.ctx.waitUntil(
			recordEmailRuntimeOutcome(this.env, {
				tediId: this.state.tediId,
				messageIdHeader,
				runId: emailRunId,
				result: "completed",
				elapsedMs: Date.now() - outcomeStartedAt,
				replied: result.replied,
			}),
		);

		// Mirror to ledger via queue (ASAP, FIFO, retried) — same fan-out as the
		// chat path so we reuse the same dedup/idempotency story.
		void this.queue(
			"onLedgerMirror",
			{
				sessionKey,
				user: userTurn,
				assistant: assistantTurn,
				runId: emailRunId,
				origin: "chat",
				...(result.usage ? { facetUsage: result.usage } : {}),
			},
			{ retry: { maxAttempts: 5 } },
		).catch((e) => {
			logTediRuntimeFailure("tedi.runtime.email_ledger_mirror_queue_failed", e);
		});

		// Brain + rationale + artifact bridge + daily log. An untrusted sender's
		// turn is never learned from (`emailTurnMemoryEffects`); compaction is
		// session-size management only and stays on for every email.
		await this.dispatchTurnMemoryEffects({
			user: userTurn,
			assistant: assistantTurn,
			runId: emailRunId,
			origin: "chat",
			sessionKey,
			...emailTurnMemoryEffects(trust),
		});
		await this.enqueueCompaction(sessionKey);

		const replied = result.replied;
		console.log(`[isolate.email] onEmail completed replied=${replied}`);
	},
	// ===========================================================================
	// Inbound surfaces
	// ===========================================================================

	/**
	 * Email-channel turn.
	 * The turn runs IN-BAND on the email conversation's OWN ConversationFacet
	 * via Pi's native submission task: the parent blocks here until the facet
	 * turn completes, so the `reply_to_email` tool — served PARENT-side through
	 * the per-runId proxy registry — executes while the live `AgentEmail`
	 * RpcTarget is still valid and flushes the HMAC-signed reply before
	 * `onEmail` returns. The shared-session-tree confidentiality leak is
	 * structurally impossible: the facet's session tree
	 * holds ONLY this email thread, never Tedix OS-visible history.
	 */
	async completeEmailTurn(
		this: RuntimeChannelsHost,
		input: {
			system: string;
			sessionKey: string;
			runId: string;
			inboundEmail: AgentEmail;
			payload: InboundEmailPayload;
			guardedUserText: string;
			trust: InboundEmailTrust;
			userTs: number;
		},
	): Promise<{ text: string; replied: boolean; usage?: FacetTurnUsage }> {
		// Parent-side reply closure over the live AgentEmail bridge. The facet
		// proxies `reply_to_email` back into this registry entry in-band, so the
		// bridge is alive for exactly as long as this method is on the stack.
		let replied = false;
		const runReplyToEmail = async (args: {
			text?: unknown;
			subject?: unknown;
		}): Promise<unknown> => {
			const text = typeof args.text === "string" ? args.text : "";
			if (!text.trim()) {
				throw new Error("reply_to_email: `text` is required");
			}
			const subject =
				typeof args.subject === "string" && args.subject.trim().length > 0
					? args.subject
					: undefined;
			const fromName =
				this.state.slug || this.name || this.state.tediId || "tedi";
			const secret = this.env.EMAIL_SECRET || null;
			await this.replyToEmail(input.inboundEmail, {
				fromName,
				body: text,
				...(subject ? { subject } : {}),
				...(secret ? { secret } : {}),
				headers: { [AUTO_SUBMITTED_HEADER]: AUTO_SUBMITTED_VALUE },
			});
			replied = true;
			return {
				ok: true,
				signedReplyToken: Boolean(secret),
				to: input.payload.from,
				threadId: input.payload.threadId,
				subject: subject ?? `Re: ${input.payload.subject}`,
			};
		};
		const replyToolSpec = buildReplyToEmailToolSpec();
		const replyTool = tool({
			description: replyToolSpec.function.description,
			inputSchema: jsonSchema(
				replyToolSpec.function.parameters as Parameters<typeof jsonSchema>[0],
			),
			execute: async (args) =>
				runReplyToEmail(args as { text?: unknown; subject?: unknown }),
		});

		const mcpRuntime = await this.getMcpRuntime();
		const platform = await this.getPlatformClient();
		const conversationId = buildTediConversationId({
			tediRef: this.state.slug || this.state.tediId,
			sessionKey: input.sessionKey,
		});
		let turnBinding: ActiveTurnBinding | null = null;
		if (mcpRuntime && platform) {
			mcpRuntime.bindTurn({
				platform,
				conversationId,
				runId: input.runId,
				traceId: input.runId,
			});
			turnBinding = {
				platform,
				conversationId,
				runId: input.runId,
				sessionKey: input.sessionKey,
				traceId: input.runId,
			};
		}
		const computerScope = computerWorkspaceScope(input);
		// Same facet tool surface as the MCP/mesh turn plus the
		// email-only reply tool — one ToolSet composition for every facet turn
		// host, so the surfaces never drift apart again.
		const tools = selectEmailTurnTools({
			trust: input.trust,
			full: {
				...this.workspaceAiTools(computerScope, turnBinding),
				...(mcpRuntime ? tedixMcpAITools(mcpRuntime, turnBinding) : {}),
				...this.browserAiTools(computerScope, turnBinding),
				...this.skillReadTool(turnBinding),
				...this.durableCodemodeAiTools(computerScope, turnBinding),
				...this.cronAiTool(input.sessionKey),
				...this.workstationAiTool(computerScope, turnBinding),
				...this.objectStoreAiTools(),
				...this.r2SqlAiTool(),
			},
			replyTool,
		});
		const system = mcpRuntime
			? `${input.system}\n\n${mcpRuntime.getSystemInstructions()}\n\n${WORKSPACE_TOOLS_NOTE}\n\n${CODE_MODE_BATCHING_NOTE}`
			: `${input.system}\n\n${WORKSPACE_TOOLS_NOTE}\n\n${CODE_MODE_BATCHING_NOTE}`;
		try {
			const facetTurn = await this.runConversationFacetTurn({
				guardedUserText: input.guardedUserText,
				maxSteps: this.effectiveStepCeiling(),
				runId: input.runId,
				sessionKey: input.sessionKey,
				surface: "email",
				system,
				tools,
				userTs: input.userTs,
			});
			if (facetTurn.turnError) {
				// Same failure contract as the legacy loop: throw out of onEmail —
				// the durable mailbox row (persisted upstream before onEmail runs)
				// keeps the email; nothing is silently dropped.
				throw new Error(facetTurn.turnError);
			}
			return {
				text: facetTurn.assistantText,
				replied,
				...(facetTurn.usage ? { usage: facetTurn.usage } : {}),
			};
		} finally {
			try {
				mcpRuntime?.clearTurn();
			} catch {
				/* defensive */
			}
		}
	},
	async streamChatTurn(
		this: RuntimeChannelsHost,
		input: NativeAcpTurnInput,
		serviceOperationId?: string,
	): Promise<Response> {
		await this.ensureIdentity();
		// Per-visitor / per-origin hourly ceiling for embedded sessions, decided
		// before admission so a refused turn is never accepted or counted.
		const quotaRefusal = await refuseOverEmbeddedTurnQuota(
			this.ctx.storage,
			input,
			this.state.tediId,
		);
		if (quotaRefusal) return quotaRefusal;
		const sessionKey = input.sessionKey;
		const streamOrigin = input.origin ?? "chat";
		const sseRunId = buildRunId(
			this.state.tediId,
			input.clientRequestId,
			streamOrigin,
		);
		await this.acceptRuntimeTurn(
			sseRunId,
			sessionKey,
			input,
			serviceOperationId === input.clientRequestId &&
				serviceOperationId !== undefined,
		);

		// Transcribe audio / surface files BEFORE the stream opens — a voice-only
		// note arrives with empty text and the transcript becomes the turn content.
		// (Shared `@tedix/voice/stt`; routes through the AI Gateway when configured.)
		// Vision-capable image attachments become model image parts (FAIL-SOFT).
		const resolvedTurn = await this.resolveAttachmentTurn(
			input.text.trim(),
			input.attachments,
		);
		const userMessage = resolvedTurn.content.trim();
		const turnImages = resolvedTurn.images;
		const learningMode =
			input.learningMode ??
			adaptiveLearningModeForTurn({ userText: userMessage });
		// The turn pump emits every frame into `chatStreamHub`, which assigns the resumable
		// `id: {runId}:{seq}` line and fans out to the live sink(s). A pre-run
		// validation error needs no id — there is no run to resume.
		if (!userMessage) {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ kind: "error", message: "text is required" })}\n\n`,
							),
						);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-store",
						"X-Accel-Buffering": "no",
					},
				},
			);
		}

		const userTurn: RecentTurn = {
			role: "user",
			content: userMessage,
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			sessionKey,
			ts: Date.now(),
		};
		await this.sessionHarness.appendTurn(
			sessionKey,
			userTurn,
			deriveIdempotencyKey(sseRunId, "user"),
		);
		const runTurn = async (): Promise<void> => {
			let finalized = false;
			let partialTextLength = 0;
			try {
				this.chatStreamHub.emit(sseRunId, {
					kind: "phase",
					phase: "preparing_context",
				});
				let result: {
					text: string;
					usage?: FacetTurnUsage;
					stopReason?: FacetBudgetStopReason;
				};
				{
					const [mcpRuntime, platform] = await Promise.all([
						this.getMcpRuntime(),
						this.getPlatformClient(),
					]);
					let turnBinding: ActiveTurnBinding | null = null;
					if (mcpRuntime && platform) {
						const conversationId = buildTediConversationId({
							tediRef: this.state.slug || this.state.tediId,
							sessionKey,
						});
						turnBinding = {
							platform,
							conversationId,
							runId: sseRunId,
							traceId: sseRunId,
							toolArgumentConstraints: input.toolArgumentConstraints,
							toolNamespacePrefix: input.toolNamespacePrefix,
							toolAllowedCallables: input.toolAllowedCallables,
							embeddedSessionToken: input.embeddedSessionToken,
						};
						mcpRuntime.bindTurn(turnBinding);
						platform.setEpisodeTrace(sseRunId);
					}
					const contextPolicy = resolveChatContext(input, sseRunId);
					const [mcpTools, embeddedFit] = await Promise.all([
						mcpRuntime
							? preparedTedixMcpAITools(mcpRuntime, turnBinding)
							: Promise.resolve({}),
						input.toolArgumentConstraints &&
						turnBinding &&
						input.toolAllowedCallables?.length
							? embeddedToolFitGuidance({
									turnText: userMessage,
									readCallables: input.toolAllowedCallables,
									runId: sseRunId,
									rank: (request) =>
										turnBinding.platform.rankDiscovery(request),
								})
							: Promise.resolve(""),
					]);
					const computerScope = computerWorkspaceScope({ sessionKey });
					const trust = input.trust ?? "trusted";
					const trustChannel = input.trustChannel ?? "mcp";
					// An unverified author keeps only the channel's read-only allowlist
					// on top of the fenced (embedded) or full surface.
					const tools: ToolSet = selectTrustedTurnTools({
						trust,
						allowlist: untrustedTurnToolAllowlist(trustChannel),
						full: input.toolArgumentConstraints
							? mcpTools
							: {
									...this.workspaceAiTools(computerScope, turnBinding),
									...mcpTools,
									...this.browserAiTools(computerScope, turnBinding),
									...this.skillReadTool(turnBinding),
									...this.durableCodemodeAiTools(computerScope, turnBinding),
									...this.cronAiTool(sessionKey),
									...this.workstationAiTool(computerScope, turnBinding),
									...this.objectStoreAiTools(),
									...this.r2SqlAiTool(),
								},
					});
					const addenda = contextPolicy.cognitiveAddenda
						? await this.cognitiveAddenda(sessionKey, userMessage, turnBinding)
						: "";
					const toolsNote = input.toolArgumentConstraints
						? ""
						: WORKSPACE_TOOLS_NOTE;
					// Turn-invariant blocks first; see cacheOrderedSystemPrompt.
					const system = cacheOrderedSystemPrompt(
						[
							this.state.systemPrompt,
							(contextPolicy.compactInstructions
								? mcpRuntime?.getUtilitySystemInstructions()
								: mcpRuntime?.getSystemInstructions()) ?? "",
							toolsNote,
							CODE_MODE_BATCHING_NOTE,
							trust === "untrusted"
								? untrustedTurnSystemAddendum(trustChannel)
								: "",
						],
						[addenda, embeddedFit ?? ""],
					);
					if (turnBinding) this.activeTurnBinding = turnBinding;
					// Per turn: the counts are meaningless across turns and the map
					// would otherwise grow for the life of the Durable Object.
					const toolInputProgress = createToolInputProgress();
					// The loop starts in planning; the tracker stamps generating on the
					// first assistant text chunk and using_tool on each tool start.
					const phaseTracker = createRuntimePhaseTracker();
					try {
						this.chatStreamHub.emit(sseRunId, phaseTracker.start());
						const facetTurn = await this.streamConversationFacetTurn({
							durableSubmissionId: input.durableSubmissionId ?? sseRunId,
							messengerMetadata: input.messengerMetadata,
							originalUiMessage: input.originalUiMessage,
							regenerationOf: input.regenerationOf,
							...(turnImages.length > 0 ? { images: turnImages } : {}),
							maxSteps: this.effectiveStepCeiling(),
							onDelta: (text) => {
								if (!text) return;
								partialTextLength += text.length;
								this.chatStreamHub.emit(sseRunId, { kind: "delta", text });
							},
							onChunk: (body) => {
								this.chatStreamHub.emit(sseRunId, { kind: "chunk", body });
								const phase = phaseTracker.read(body);
								if (phase) this.chatStreamHub.emit(sseRunId, phase);
								// Display-only: a count, never the argument text it measures.
								const inputProgress = toolInputProgress.read(body);
								if (inputProgress)
									this.chatStreamHub.emit(sseRunId, inputProgress);
							},
							runId: sseRunId,
							sessionKey,
							system,
							tools,
							userText: userMessage,
							userTs: userTurn.ts,
							modelRefOverride: input.modelRefOverride,
							...(input.reasoningEffortOverride
								? { reasoningEffortOverride: input.reasoningEffortOverride }
								: {}),
							maxOutputTokensOverride: contextPolicy.maxOutputTokens,
						});
						if (facetTurn.turnError) {
							throw new Error(facetTurn.turnError);
						}
						result = {
							text: facetTurn.assistantText,
							...(facetTurn.usage ? { usage: facetTurn.usage } : {}),
							...(facetTurn.stopReason
								? { stopReason: facetTurn.stopReason }
								: {}),
						};
					} finally {
						try {
							mcpRuntime?.clearTurn();
						} catch {}
						if (this.activeTurnBinding === turnBinding) {
							this.clearActiveTurn();
						}
					}
				}
				const assistantTurn: RecentTurn = {
					role: "assistant",
					content: result.text,
					sessionKey,
					ts: Date.now(),
				};
				this.chatStreamHub.emit(sseRunId, {
					kind: "phase",
					phase: "finalizing",
				});
				if (serviceOperationId) {
					await this.onLedgerMirror({
						sessionKey,
						user: userTurn,
						assistant: assistantTurn,
						runId: sseRunId,
						origin: streamOrigin,
						...(result.usage ? { facetUsage: result.usage } : {}),
						...(result.stopReason ? { stopReason: result.stopReason } : {}),
					});
					if (
						this.runtimeAdmission() &&
						!(await this.ctx.storage.get(
							`runtime-admission-settlement:${sseRunId}`,
						))
					)
						throw new Error(
							"Original Telegram answer settlement is incomplete",
						);
				}
				await finalizeSuccessfulChatStream({
					hub: this.chatStreamHub,
					runId: sseRunId,
					text: result.text,
					sessionKey,
					ts: assistantTurn.ts,
					appendTurn: () =>
						this.sessionHarness.appendTurn(
							sessionKey,
							assistantTurn,
							deriveIdempotencyKey(sseRunId, "assistant"),
						),
				});
				finalized = true;
				await this.dispatchTurnMemoryEffects({
					user: userTurn,
					assistant: assistantTurn,
					runId: sseRunId,
					origin: streamOrigin,
					sessionKey,
					learningMode:
						learningMode === "disabled"
							? "disabled"
							: adaptiveLearningModeForTurn({
									userText: userTurn.content,
									assistantText: assistantTurn.content,
								}),
					...trustedTurnMemoryEffects(input.trust ?? "trusted"),
				});
				if (!serviceOperationId)
					await this.queue(
						"onLedgerMirror",
						{
							sessionKey,
							user: userTurn,
							assistant: assistantTurn,
							runId: sseRunId,
							origin: streamOrigin,
							...(result.usage ? { facetUsage: result.usage } : {}),
							...(result.stopReason ? { stopReason: result.stopReason } : {}),
						},
						{ retry: { maxAttempts: 5 } },
					).catch((e) => {
						logTediRuntimeFailure(
							"tedi.runtime.stream_ledger_mirror_queue_failed",
							e,
						);
					});
				await this.enqueueCompaction(sessionKey);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (finalized) {
					logTediRuntimeFailure(
						"tedi.runtime.stream_postdone_effects_failed",
						err,
						"error",
					);
					return;
				}
				// Keep the failure observable without logging session or provider text.
				// The customer-facing error frame keeps its existing behavior.
				logTediRuntimeFailure("tedi.runtime.stream_turn_failed", err, "error");
				if (!isEphemeralSession(sessionKey)) {
					await this.emitFailureTraceBundle({
						runId: sseRunId,
						conversationId: buildTediConversationId({
							tediRef: this.state.slug || this.state.tediId,
							sessionKey,
						}),
						sessionKey,
						startedAt: new Date(userTurn.ts).toISOString(),
						userText: userTurn.content,
						partialTextLength,
						reason: "native_pi_terminal_failure",
					});
					await this.mirrorFailedTurn({
						sessionKey,
						runId: sseRunId,
						user: userTurn,
						error: msg,
					});
				}
				this.chatStreamHub.emit(sseRunId, { kind: "error", message: msg });
				this.chatStreamHub.closeRun(sseRunId);
			}
		};

		// Open the run + register THIS response's controller as the primary sink,
		// then kick the pump under `ctx.waitUntil`. The stream stays open until the
		// pump calls `closeRun` (done/error). A client drop → `cancel` detaches
		// only this sink; the pump keeps buffering for a resume GET.
		let primarySink: FrameSink | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				primarySink = this.sseControllerSink(controller);
				this.chatStreamHub.openRun(sseRunId, primarySink);
				this.ctx.waitUntil(runTurn());
			},
			cancel: () => {
				if (primarySink) this.chatStreamHub.detach(sseRunId, primarySink);
			},
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
			},
		});
	},
	/** Adapt a ReadableStream controller to a hub {@link FrameSink}. */
	sseControllerSink(
		this: RuntimeChannelsHost,
		controller: ReadableStreamDefaultController<Uint8Array>,
	): FrameSink {
		this.sseFrameEncoder ??= new TextEncoder();
		const enc = this.sseFrameEncoder;
		return {
			// A write to a closed/cancelled controller THROWS — `ChatStreamHub`
			// catches it and drops the dead sink; that is how a disconnected client
			// is pruned from the live fan-out.
			write: (chunk) => controller.enqueue(enc.encode(chunk)),
			close: () => {
				try {
					controller.close();
				} catch {
					/* idempotent */
				}
			},
		};
	},
	/**
	 * GET `/__internal/chat/stream?run_id=…` — RESUME a chat turn's SSE stream.
	 * The initiating turn is a POST (message body); this GET lets a reconnecting
	 * `EventSource` re-attach with its `Last-Event-ID` (header, or `?last_event_id=`
	 * fallback) and receive exactly the missed frames then the live continuation.
	 * No message, no turn kicked — pure attach to the in-memory {@link chatStreamHub}.
	 * `no-run` (unknown run, or the DO evicted its buffer) → a typed `error` frame
	 * so the client re-sends rather than hanging.
	 */
	resumeChatStream(
		this: RuntimeChannelsHost,
		request: Request,
		url: URL,
	): Response {
		const runId = (url.searchParams.get("run_id") ?? "").trim();
		if (!runId) {
			return Response.json(
				{ ok: false, error: "run_id is required" },
				{ status: 400 },
			);
		}
		// First connect (no Last-Event-ID) → deliver the whole buffered stream from
		// seq 0 then go live: synthesize `seq:-1` so `resolve` replays every frame
		// after -1 (all of them). A real reconnect carries the header.
		const headerId = parseLastEventId(
			request.headers.get("Last-Event-ID") ??
				url.searchParams.get("last_event_id"),
		);
		const lastEventId = headerId ?? { runId, seq: -1 };
		const hub = this.chatStreamHub;
		let sink: FrameSink | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				sink = this.sseControllerSink(controller);
				const res = hub.attach(runId, sink, lastEventId);
				if (res.outcome === "fresh") {
					// No buffer to resume from (evicted / unknown / too far behind).
					// Tell the client to re-send the turn; keep the frame contract.
					try {
						sink.write(
							`data: ${JSON.stringify({ kind: "error", message: "stream_unavailable", reason: res.reason, recoverable: true })}\n\n`,
						);
					} catch {
						/* controller already gone */
					}
					try {
						controller.close();
					} catch {
						/* idempotent */
					}
				}
				// "attached-live" → sink stays subscribed for the continuation.
				// "replayed-terminated" → attach already replayed the tail + closed.
			},
			cancel: () => {
				if (sink) hub.detach(runId, sink);
			},
		});
		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
			},
		});
	},
};
