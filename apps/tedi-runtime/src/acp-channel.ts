import type { Connection } from "agents";
import type { SessionMessage } from "agents/sessions";
import { parseProtocolMessage, CHAT_MESSAGE_TYPES } from "agents/chat";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import type { AudioAttachment } from "@tedix/voice/stt";
import type { StreamChatTurnInput } from "./chat-stream-input";
import type { ConversationFacet } from "./conversation-facet";

export type NativeAcpTurnInput = StreamChatTurnInput & {
	durableSubmissionId?: string;
	messengerMetadata?: Record<string, unknown>;
	originalUiMessage?: SessionMessage;
	regenerationOf?: string;
};
export type AcpConnection = Pick<Connection, "id" | "send">;
interface AcpIdentity {
	subject: string;
	orgId: string;
	tediId: string;
	canApprove: boolean;
}
export interface NativeAcpHost {
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
	identity(): { orgId: string; tediId: string };
	waitUntil(promise: Promise<unknown>): void;
	connections(): Iterable<AcpConnection>;
	facet(
		sessionKey: string,
	): Promise<
		Pick<
			ConversationFacet,
			| "resumeConfiguredConversationTurn"
			| "cancelPiTurn"
			| "pendingToolApprovals"
			| "resolveToolApproval"
			| "clearHistory"
			| "historyMessages"
		>
	>;
	runId(clientRequestId: string): string;
	cancelRun(runId: string, reason: string): Promise<void>;
	streamChatTurn(input: NativeAcpTurnInput): Promise<Response>;
	onError(error: unknown): void;
}
const MAX_CHAT_ATTACHMENTS = 8;
function unknownRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function bodyString(
	body: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = body[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Agents wire transport over native Pi facets; the host owns run authority and effects. */
export class NativeAcpChannel {
	constructor(private readonly host: NativeAcpHost) {}
	async onConnect(connection: AcpConnection, request: Request): Promise<void> {
		const headers = request.headers;
		await this.host.storage.put(`pi:acp:identity:${connection.id}`, {
			subject: headers.get("X-Tedi-Auth-Subject") ?? "",
			orgId: headers.get("X-Tedi-Auth-OrgId") ?? "",
			tediId: headers.get("X-Tedi-Auth-TediId") ?? "",
			canApprove: headers.get("X-Tedix-Can-Approve-Tools") === "true",
		});
		const url = new URL(request.url);
		const sessionKey =
			url.searchParams.get("sessionKey") ?? DEFAULT_SESSION_KEY;
		await this.host.storage.put(`pi:acp:session:${connection.id}`, sessionKey);
		const facet = await this.host.facet(sessionKey);
		connection.send(
			JSON.stringify({
				type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
				messages: await facet.historyMessages(),
			}),
		);
	}
	async onMessage(
		connection: AcpConnection,
		raw: string | ArrayBuffer,
	): Promise<boolean> {
		if (typeof raw !== "string") return false;
		const event = parseProtocolMessage(raw);
		if (!event) return false;
		if (event.type === "messages") return true; // Flat client transcript writes are never authoritative.
		if (
			event.type === "stream-resume-request" ||
			event.type === "stream-resume-ack"
		) {
			const identity = await this.host.storage.get<AcpIdentity>(
				`pi:acp:identity:${connection.id}`,
			);
			const sessionKey = await this.host.storage.get<string>(
				`pi:acp:session:${connection.id}`,
			);
			if (
				!identity?.subject ||
				identity.orgId !== this.host.identity().orgId ||
				identity.tediId !== this.host.identity().tediId ||
				!sessionKey
			)
				throw new Error("Authenticated ACP resume identity required");
			const owned = await this.host.storage.get<{
				sessionKey: string;
				clientRequestId: string;
				requestId: string;
			}>(
				`pi:acp:owned:${encodeURIComponent(identity.subject)}:${encodeURIComponent(sessionKey)}`,
			);
			if (
				!owned ||
				(event.type === "stream-resume-ack" && event.id !== owned.requestId)
			) {
				if (event.type === "stream-resume-request")
					connection.send(
						JSON.stringify({
							type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE,
							...(event.probeId ? { probeId: event.probeId } : {}),
						}),
					);
				return true;
			}
			await this.host.storage.put({
				[`pi:acp:active:${connection.id}`]: owned,
				[`pi:acp:${connection.id}:${owned.requestId}`]: owned,
			});
			if (event.type === "stream-resume-request") {
				connection.send(
					JSON.stringify({
						type: CHAT_MESSAGE_TYPES.STREAM_RESUMING,
						id: owned.requestId,
						...(event.probeId ? { probeId: event.probeId } : {}),
					}),
				);
				return true;
			}
			const facet = await this.host.facet(owned.sessionKey);
			const stream = await facet.resumeConfiguredConversationTurn(
				owned.clientRequestId,
			);
			if (!stream) {
				connection.send(
					JSON.stringify({
						type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
						id: owned.requestId,
						body: "",
						done: true,
						replay: true,
					}),
				);
				return true;
			}
			this.host.waitUntil(
				this.pumpNativeAcpResume(connection, owned.requestId, stream).catch(
					(error) => {
						this.host.onError(error);
						connection.send(
							JSON.stringify({
								type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
								id: owned.requestId,
								body: errorMessage(error),
								done: true,
								error: true,
							}),
						);
					},
				),
			);
			return true;
		}
		if (event.type === "cancel") {
			const admitted = await this.host.storage.get<{
				sessionKey: string;
				clientRequestId: string;
			}>(`pi:acp:${connection.id}:${event.id}`);
			if (!admitted) return true;
			const runId = this.host.runId(admitted.clientRequestId);
			await this.host.cancelRun(runId, "run cancelled");
			const facet = await this.host.facet(admitted.sessionKey);
			await facet.cancelPiTurn();
			return true;
		}
		if (event.type === "tool-approval") {
			const identity = await this.host.storage.get<AcpIdentity>(
				`pi:acp:identity:${connection.id}`,
			);
			if (
				!identity?.canApprove ||
				!identity.subject ||
				identity.orgId !== this.host.identity().orgId ||
				identity.tediId !== this.host.identity().tediId
			)
				throw new Error(
					"Authenticated operator tool approval authority required",
				);
			const admitted = await this.host.storage.get<{
				sessionKey: string;
				clientRequestId: string;
			}>(`pi:acp:active:${connection.id}`);
			if (!admitted)
				throw new Error("Tool approval has no owned conversation request");
			const runId = this.host.runId(admitted.clientRequestId);
			const facet = await this.host.facet(admitted.sessionKey);
			const pending = (await facet.pendingToolApprovals()).filter(
				(approval) =>
					approval.runId === runId && approval.toolCallId === event.toolCallId,
			);
			if (pending.length !== 1)
				throw new Error(
					"Tool approval does not belong to the current owned run",
				);
			const approval = pending[0];
			if (!approval) throw new Error("Tool approval unavailable");
			await facet.resolveToolApproval({
				approvalId: approval.approvalId,
				approved: event.approved,
			});
			return true;
		}
		if (event.type === "clear") {
			const identity = await this.host.storage.get<AcpIdentity>(
				`pi:acp:identity:${connection.id}`,
			);
			const sessionKey = await this.host.storage.get<string>(
				`pi:acp:session:${connection.id}`,
			);
			if (
				!identity?.subject ||
				identity.orgId !== this.host.identity().orgId ||
				identity.tediId !== this.host.identity().tediId ||
				!sessionKey
			)
				throw new Error("Authenticated ACP clear identity required");
			const admitted = await this.host.storage.get<{
				sessionKey: string;
				clientRequestId: string;
			}>(`pi:acp:active:${connection.id}`);
			if (admitted && admitted.sessionKey === sessionKey) {
				const runId = this.host.runId(admitted.clientRequestId);
				await this.host.cancelRun(runId, "conversation cleared");
			}
			const facet = await this.host.facet(sessionKey);
			await facet.cancelPiTurn();
			await facet.clearHistory();
			await this.host.storage.delete(`pi:acp:active:${connection.id}`);
			const owned = await this.host.storage.get<{ clientRequestId: string }>(
				`pi:acp:owned:${encodeURIComponent(identity.subject)}:${encodeURIComponent(sessionKey)}`,
			);
			if (owned)
				await this.host.storage.delete(
					`pi:acp:owned:${encodeURIComponent(identity.subject)}:${encodeURIComponent(sessionKey)}`,
				);
			const priorInputs = await this.host.storage.list({
				prefix: `pi:acp:user:${encodeURIComponent(identity.subject)}:${encodeURIComponent(sessionKey)}:`,
			});
			const priorInputKeys = [...priorInputs.keys()];
			for (let offset = 0; offset < priorInputKeys.length; offset += 128)
				await this.host.storage.delete(
					priorInputKeys.slice(offset, offset + 128),
				);
			// Clearing the runtime view retains the canonical D1 conversation ledger.
			for (const peer of this.host.connections()) {
				const peerIdentity = await this.host.storage.get<AcpIdentity>(
					`pi:acp:identity:${peer.id}`,
				);
				if (
					peerIdentity?.subject !== identity.subject ||
					peerIdentity.orgId !== identity.orgId ||
					peerIdentity.tediId !== identity.tediId
				)
					continue;
				if (
					(await this.host.storage.get<string>(`pi:acp:session:${peer.id}`)) !==
					sessionKey
				)
					continue;
				peer.send(JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_CLEAR }));
				peer.send(
					JSON.stringify({
						type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
						messages: [],
					}),
				);
			}
			return true;
		}
		if (event.type === "tool-result")
			throw new Error("This runtime exposes server-resolved tools only");
		if (event.type !== "chat-request") return true;
		if (event.init.method !== "POST") return true;
		const body: unknown = JSON.parse(event.init.body ?? "{}");
		const input = unknownRecord(body);
		if (!input || !Array.isArray(input.messages))
			throw new Error("ACP request requires messages");
		const messages = input.messages
			.map(unknownRecord)
			.filter(
				(message): message is Record<string, unknown> => message !== null,
			);
		const user = messages
			.slice()
			.reverse()
			.find((message) => message.role === "user");
		if (!user || typeof user.id !== "string" || !Array.isArray(user.parts))
			throw new Error("ACP input requires an exact user-message id");
		const parts = user.parts
			.map(unknownRecord)
			.filter((part): part is Record<string, unknown> => part !== null);
		const attachments: AudioAttachment[] = [];
		for (const part of parts) {
			if (part.type === "text") continue;
			if (
				part.type !== "file" ||
				typeof part.url !== "string" ||
				typeof part.mediaType !== "string"
			)
				throw new Error("Unsupported ACP user input part");
			const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
				part.url,
			);
			if (!data || data[1] !== part.mediaType || !data[2])
				throw new Error("ACP file input requires matching base64 data URL");
			attachments.push({
				content: data[2],
				mimeType: part.mediaType,
				fileName:
					typeof part.filename === "string" ? part.filename : "attachment",
				type: part.mediaType.startsWith("image/")
					? "image"
					: part.mediaType.startsWith("audio/")
						? "audio"
						: "file",
			});
		}
		if (attachments.length > MAX_CHAT_ATTACHMENTS)
			throw new Error("ACP attachment count exceeded");
		const text = parts
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("");
		const sessionKey = bodyString(input, "sessionKey") ?? DEFAULT_SESSION_KEY;
		const identity = await this.host.storage.get<AcpIdentity>(
			`pi:acp:identity:${connection.id}`,
		);
		if (
			!identity?.subject ||
			identity.orgId !== this.host.identity().orgId ||
			identity.tediId !== this.host.identity().tediId
		)
			throw new Error("Authenticated ACP connection identity required");
		const messengerMetadata = {
			source: "acp",
			subject: identity.subject,
			orgId: identity.orgId,
			tediId: identity.tediId,
		};
		const originalUiMessage: SessionMessage = {
			id: user.id,
			role: "user",
			parts: parts.map((part) =>
				part.type === "text"
					? {
							type: "text",
							text: typeof part.text === "string" ? part.text : "",
						}
					: {
							type: "file",
							url: String(part.url),
							mediaType: String(part.mediaType),
							...(typeof part.filename === "string"
								? { filename: part.filename }
								: {}),
						},
			),
		};
		if (
			input.clientTools !== undefined &&
			(!Array.isArray(input.clientTools) || input.clientTools.length !== 0)
		)
			throw new Error("This runtime exposes server-resolved tools only");
		const trigger =
			input.trigger === "regenerate-message"
				? "regenerate-message"
				: "submit-message";
		const operationId = `tedix:acp:${trigger}:${event.id}:${user.id}`;
		const attachmentFingerprints = await Promise.all(
			attachments.map(async (attachment) => {
				const digest = await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(attachment.content),
				);
				return {
					type: attachment.type,
					mimeType: attachment.mimeType,
					fileName: attachment.fileName,
					sha256: Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join(""),
				};
			}),
		);
		const claim = {
			sessionKey,
			userId: user.id,
			text,
			attachmentFingerprints,
			trigger,
			operationId,
		};
		const claimKey = `pi:acp:request:${encodeURIComponent(identity.subject)}:${encodeURIComponent(event.id)}`;
		const priorClaim = await this.host.storage.get<typeof claim>(claimKey);
		if (priorClaim && JSON.stringify(priorClaim) !== JSON.stringify(claim))
			throw new Error(
				"ACP request id was reused with different immutable input",
			);
		const userClaimKey = `pi:acp:user:${encodeURIComponent(identity.subject)}:${encodeURIComponent(sessionKey)}:${encodeURIComponent(user.id)}`;
		let regenerationOf: string | undefined;
		if (trigger === "regenerate-message") {
			const original = await this.host.storage.get<{
				text: string;
				attachmentFingerprints: typeof attachmentFingerprints;
				operationId?: string;
			}>(userClaimKey);
			if (original) {
				if (
					original.text !== text ||
					JSON.stringify(original.attachmentFingerprints) !==
						JSON.stringify(attachmentFingerprints)
				)
					throw new Error("Regeneration cannot alter original user input");
				regenerationOf = original.operationId;
				if (!regenerationOf)
					throw new Error("Regeneration has no owned native operation");
			} else {
				throw new Error(
					"Regeneration requires a server-owned native user operation",
				);
			}
		} else {
			const existing = await this.host.storage.get<{
				text: string;
				attachmentFingerprints: typeof attachmentFingerprints;
			}>(userClaimKey);
			if (
				existing &&
				(existing.text !== text ||
					JSON.stringify(existing.attachmentFingerprints) !==
						JSON.stringify(attachmentFingerprints))
			)
				throw new Error("ACP user id reused with different immutable input");
			if (!existing)
				await this.host.storage.put(userClaimKey, {
					text,
					attachmentFingerprints,
					operationId,
				});
		}
		if (!priorClaim) await this.host.storage.put(claimKey, claim);
		await this.host.storage.put({
			[`pi:acp:${connection.id}:${event.id}`]: {
				sessionKey,
				clientRequestId: operationId,
			},
			[`pi:acp:active:${connection.id}`]: {
				sessionKey,
				clientRequestId: operationId,
			},
			[`pi:acp:session:${connection.id}`]: sessionKey,
			[`pi:acp:owned:${encodeURIComponent(identity.subject)}:${encodeURIComponent(sessionKey)}`]:
				{ sessionKey, clientRequestId: operationId, requestId: event.id },
		});
		this.host.waitUntil(
			this.pumpNativeAcpTurn(connection, event.id, {
				sessionKey,
				text,
				messengerMetadata,
				originalUiMessage,
				regenerationOf,
				attachments: attachments.length ? attachments : undefined,
				clientRequestId: operationId,
				durableSubmissionId: operationId,
			}).catch((error) => {
				this.host.onError(error);
				connection.send(
					JSON.stringify({
						type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
						id: event.id,
						body: errorMessage(error),
						done: true,
						error: true,
					}),
				);
			}),
		);
		return true;
	}
	private forwardNativeAcpChunk(
		connection: AcpConnection,
		requestId: string,
		body: string,
		replay = false,
	): void {
		const frame = unknownRecord(JSON.parse(body));
		if (frame?.type === "data-pi-snapshot") {
			const data = unknownRecord(frame.data);
			if (!data || !Array.isArray(data.messages))
				throw new Error("Native ACP snapshot lacks messages");
			const messages = [...data.messages];
			const partial = unknownRecord(data.partialMessage);
			if (
				partial &&
				typeof partial.id === "string" &&
				partial.role === "assistant" &&
				Array.isArray(partial.parts)
			)
				messages.push(partial);
			connection.send(
				JSON.stringify({ type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES, messages }),
			);
			return;
		}
		connection.send(
			JSON.stringify({
				type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
				id: requestId,
				body,
				done: false,
				...(replay ? { replay: true } : {}),
			}),
		);
	}
	private async pumpNativeAcpResume(
		connection: AcpConnection,
		requestId: string,
		stream: ReadableStream<Uint8Array>,
	): Promise<void> {
		const reader = stream.getReader(),
			decoder = new TextDecoder();
		let buffer = "";
		let completed = false;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				buffer += decoder.decode(next.value, { stream: true });
				for (;;) {
					const end = buffer.indexOf("\n");
					if (end < 0) break;
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					if (!line) continue;
					const value = unknownRecord(JSON.parse(line));
					if (!value) continue;
					if (value.kind === "chunk" && typeof value.body === "string")
						this.forwardNativeAcpChunk(connection, requestId, value.body, true);
					if (value.kind === "error")
						throw new Error(
							typeof value.message === "string"
								? value.message
								: "ACP resume failed",
						);
					if (value.kind === "done") {
						completed = true;
						connection.send(
							JSON.stringify({
								type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
								id: requestId,
								body: "",
								done: true,
								replay: true,
							}),
						);
					}
				}
			}
			if (!completed)
				throw new Error("ACP resume ended without terminal frame");
		} finally {
			reader.releaseLock();
		}
	}
	private async pumpNativeAcpTurn(
		connection: AcpConnection,
		requestId: string,
		input: NativeAcpTurnInput,
	): Promise<void> {
		const response = await this.host.streamChatTurn(input);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("ACP turn stream unavailable");
		const decoder = new TextDecoder();
		let buffer = "";
		let completed = false;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				buffer += decoder.decode(next.value, { stream: true });
				for (;;) {
					const end = buffer.indexOf("\n\n");
					if (end < 0) break;
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = frame
						.split("\n")
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) continue;
					const value = unknownRecord(JSON.parse(data));
					if (!value) continue;
					if (value.kind === "chunk" && typeof value.body === "string")
						this.forwardNativeAcpChunk(connection, requestId, value.body);
					if (value.kind === "error")
						throw new Error(
							typeof value.message === "string"
								? value.message
								: "ACP turn failed",
						);
					if (value.kind === "done") {
						completed = true;
						connection.send(
							JSON.stringify({
								type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
								id: requestId,
								body: "",
								done: true,
							}),
						);
					}
				}
			}
			if (!completed) throw new Error("ACP turn ended without terminal frame");
		} catch (error) {
			this.host.onError(error);
			connection.send(
				JSON.stringify({
					type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
					id: requestId,
					body: errorMessage(error),
					done: true,
					error: true,
				}),
			);
		} finally {
			reader.releaseLock();
		}
	}
}
