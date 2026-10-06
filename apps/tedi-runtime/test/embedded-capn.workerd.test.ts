import { describe, expect, it } from "vite-plus/test";
import {
	authenticateEmbeddedSocket,
	createEmbeddedClient,
} from "@tedix/chat-transport/embedded-client";
import {
	scopedTurnKey,
	type EmbeddedCapabilityAdapter,
} from "@tedix/chat-transport/embedded-capability";
import { mountEmbeddedCapability } from "@tedix/chat-transport/embedded-mount";

const ORIGIN = "https://staging.example-saas.com";

function request() {
	return new Request("https://example-saas.tedi.tedix.dev/chat/capn", {
		headers: { Origin: ORIGIN, Upgrade: "websocket" },
	});
}

function adapter(
	calls: Array<{ operation: string; body: unknown }>,
): EmbeddedCapabilityAdapter {
	return {
		readTranscript: async (token) => {
			calls.push({ operation: "readTranscript", body: token });
			return {
				messages: [
					{ role: "user", content: "hola" },
					{ role: "assistant", content: "Hola" },
				],
			};
		},
		authorize: async (token) => {
			if (token !== "signed") throw new Error("Forbidden");
			return {
				sessionKey: "example-widget:367:1743:conversation-a",
				subject: "1743",
				tenant: "example-saas:367",
				origin: ORIGIN,
				expiresAt: Date.now() + 60_000,
			};
		},
		stream: async (_token, input) => {
			calls.push({
				operation: "stream",
				body: input,
			});
			return new Response(
				'id: runtime:1\ndata: {"kind":"delta","text":"Hola"}\n\n' +
					'id: runtime:2\ndata: {"kind":"done","text":"Hola"}\n\n',
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
		cancel: async (_token, turnKey) => ({ turnKey }),
		listApprovals: async () => ({ data: [] }),
		requestApproval: async (_token, description) => ({ description }),
		resolveApproval: async (_token, id, approved) => ({ id, approved }),
		pin: async (_token, summary, pageContext) => ({ summary, pageContext }),
		metrics: async () => {},
		callPortableTool: async (_token, input) => ({ input }),
		rankPortableTools: async (_token, input) => {
			calls.push({ operation: "rankPortableTools", body: input });
			return { rankedIds: null, receipt: null };
		},
		listConversationCapabilities: async () => {
			calls.push({ operation: "listConversationCapabilities", body: null });
			return { attached: [], available: [], authority: "context_only" };
		},
		attachConversationCapability: async (_token, input) => {
			calls.push({ operation: "attachConversationCapability", body: input });
			return {
				capability: {
					id: "11111111-1111-4111-8111-111111111111",
					capabilityId: input.capabilityId,
					replayName: input.replayName,
					name: "Research",
					slug: "research",
					whyPresent: { type: "user", actorId: "1743", attachedAt: "now" },
					authority: "context_only",
				},
			};
		},
		detachConversationCapability: async (_token, referenceId) => {
			calls.push({
				operation: "detachConversationCapability",
				body: referenceId,
			});
			return { detached: true, referenceId };
		},
		listConversationArtifactPins: async () => {
			calls.push({ operation: "listConversationArtifactPins", body: null });
			return { pins: [] };
		},
		attachConversationArtifactPin: async (_token, input) => {
			calls.push({ operation: "attachConversationArtifactPin", body: input });
			return {
				pin: {
					id: "33333333-3333-4333-8333-333333333333",
					artifactId: input.artifactId,
					replayName: input.replayName,
					revision: { algorithm: "sha256", digest: "a".repeat(64) },
					artifact: {
						name: "Report",
						kind: "file",
						mimeType: "text/plain",
						uri: "r2://bucket/report",
					},
					state: "active",
					whyPresent: { type: "user", actorId: "1743", attachedAt: "now" },
					authority: "context_only",
				},
			};
		},
		detachConversationArtifactPin: async (_token, pinId) => {
			calls.push({ operation: "detachConversationArtifactPin", body: pinId });
			return { detached: true, pinId };
		},
		runId: (turnKey) => `runtime:chat:${turnKey}`,
	};
}

describe("embedded Cap'n Web roundtrip", () => {
	it.each([
		["Session expired", "Session expired"],
		[
			"Session expired before stream dispatch",
			"Session expired before stream dispatch",
		],
		["provider secret: private-token", "The embedded capability call failed."],
		["Session expired: private-token", "The embedded capability call failed."],
	])(
		"serializes only exact public expiry signals: %s",
		async (message, expected) => {
			const backend = adapter([]);
			backend.readTranscript = async () => {
				throw new Error(message, { cause: "private-cause" });
			};
			const response = mountEmbeddedCapability(request(), backend);
			const socket = (
				response as Response & {
					webSocket?: (WebSocket & { accept(): void }) | null;
				}
			).webSocket;
			if (!socket) throw new Error("upgrade returned no client socket");
			socket.accept();
			const session = await authenticateEmbeddedSocket(socket, "signed");
			try {
				await expect(session.readTranscript()).rejects.toMatchObject({
					message: expected,
				});
			} finally {
				session[Symbol.dispose]?.();
			}
		},
	);

	it("preserves the pre-dispatch expiry signal without starting the turn", async () => {
		const calls: Array<{ operation: string; body: unknown }> = [];
		const backend = adapter(calls);
		const response = mountEmbeddedCapability(request(), backend);
		const socket = (
			response as Response & {
				webSocket?: (WebSocket & { accept(): void }) | null;
			}
		).webSocket;
		if (!socket) throw new Error("upgrade returned no client socket");
		socket.accept();
		const session = await authenticateEmbeddedSocket(socket, "signed");
		backend.authorize = async () => {
			throw new Error("Session expired");
		};
		try {
			await expect(
				session.stream(
					{ clientRequestId: "request_expired", text: "hola" },
					async () => {},
				),
			).rejects.toMatchObject({
				message: "Session expired before stream dispatch",
			});
			expect(calls).toEqual([]);
		} finally {
			session[Symbol.dispose]?.();
		}
	});

	it("refreshes an idle expired capability and dispatches the same request exactly once", async () => {
		const calls: Array<{ operation: string; body: unknown }> = [];
		let credentials = 0;
		const tokens: string[] = [];
		const client = createEmbeddedClient(
			async () => ({
				streamUrl: "https://example-saas.tedi.tedix.dev",
				token: `signed-${++credentials}`,
			}),
			async ({ token }) => {
				tokens.push(token);
				const backend = adapter(calls);
				const authority = await backend.authorize("signed");
				backend.authorize = async (provided) => {
					if (provided !== token) throw new Error("Forbidden");
					return authority;
				};
				const response = mountEmbeddedCapability(request(), backend);
				const socket = (
					response as Response & {
						webSocket?: (WebSocket & { accept(): void }) | null;
					}
				).webSocket;
				if (!socket) throw new Error("upgrade returned no client socket");
				socket.accept();
				const session = await authenticateEmbeddedSocket(socket, token);
				// Expire the server-held authority after authentication, before dispatch.
				if (token === "signed-1") authority.expiresAt = Date.now() - 1;
				return session;
			},
		);
		const answers: string[] = [];
		try {
			await client.stream(
				{ clientRequestId: "request_idle_refresh", text: "hola" },
				async (frame) => {
					if (frame.event.kind === "done")
						answers.push(String(frame.event.text));
				},
			);
			expect(tokens).toEqual(["signed-1", "signed-2"]);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({
				operation: "stream",
				body: {
					turnKey: await scopedTurnKey(
						await adapter([]).authorize("signed"),
						"request_idle_refresh",
					),
					text: "hola",
					resume: false,
				},
			});
			expect(answers).toEqual(["Hola"]);
		} finally {
			client.dispose();
		}
	});

	it("authenticates in-band and streams callbacks across a real workerd socket", async () => {
		const calls: Array<{ operation: string; body: unknown }> = [];
		const response = mountEmbeddedCapability(request(), adapter(calls));
		expect(response.status).toBe(101);
		const socket = (
			response as Response & {
				webSocket?: (WebSocket & { accept(): void }) | null;
			}
		).webSocket;
		if (!socket) throw new Error("upgrade returned no client socket");
		socket.accept();
		const session = await authenticateEmbeddedSocket(socket, "signed");
		const text: string[] = [];
		await session.stream(
			{ clientRequestId: "request_123", text: "hola" },
			async (frame) => {
				if (frame.event.kind === "delta") text.push(String(frame.event.text));
			},
		);
		expect(text.join("")).toBe("Hola");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.operation).toBe("stream");
		expect(calls[0]?.body).toMatchObject({ text: "hola" });
		const removed = session as unknown as {
			getAttentionBrief(): Promise<unknown>;
			recordAttentionOutcome(input: unknown): Promise<unknown>;
		};
		expect(() => removed.getAttentionBrief()).toThrow(TypeError);
		expect(() => removed.recordAttentionOutcome({})).toThrow(TypeError);
		expect(calls).toHaveLength(1);
		expect((await session.listConversationCapabilities()).authority).toBe(
			"context_only",
		);
		const capabilityId = "22222222-2222-4222-8222-222222222222";
		const referenceId = "11111111-1111-4111-8111-111111111111";
		await session.attachConversationCapability({
			capabilityId,
			replayName: "research",
		});
		await session.detachConversationCapability(referenceId);
		expect((await session.listConversationArtifactPins()).pins).toEqual([]);
		const pinId = "33333333-3333-4333-8333-333333333333";
		await session.attachConversationArtifactPin({
			artifactId: "artifact-1",
			replayName: "approved_report",
		});
		await session.detachConversationArtifactPin(pinId);
		expect(calls.slice(1)).toEqual([
			{ operation: "listConversationCapabilities", body: null },
			{
				operation: "attachConversationCapability",
				body: { capabilityId, replayName: "research" },
			},
			{ operation: "detachConversationCapability", body: referenceId },
			{ operation: "listConversationArtifactPins", body: null },
			{
				operation: "attachConversationArtifactPin",
				body: { artifactId: "artifact-1", replayName: "approved_report" },
			},
			{ operation: "detachConversationArtifactPin", body: pinId },
		]);
		expect(await session.readTranscript()).toEqual({
			messages: [
				{ role: "user", content: "hola" },
				{ role: "assistant", content: "Hola" },
			],
		});
		expect(calls.at(-1)).toEqual({
			operation: "readTranscript",
			body: "signed",
		});
		session[Symbol.dispose]?.();
	});
});

describe("pipelined embedded frames over real RPC", () => {
	it("serializes async consumers and resumes original cursors without duplicating text", async () => {
		const requests: Array<{ resume: boolean; lastEventId?: string }> = [];
		let runId = "";
		const client = createEmbeddedClient(
			async () => ({
				streamUrl: "https://example-saas.tedi.tedix.dev",
				token: "signed",
			}),
			async () => {
				const backend = adapter([]);
				backend.stream = async (_token, input) => {
					runId = input.runId;
					requests.push({
						resume: input.resume,
						lastEventId: input.lastEventId,
					});
					const after = input.lastEventId
						? Number(input.lastEventId.slice(runId.length + 1))
						: -1;
					// The first subscription drops after twelve committed frames.
					const end = requests.length === 1 ? 12 : 25;
					return new Response(
						Array.from({ length: end }, (_, index) =>
							index <= after
								? ""
								: `id: ${runId}:${index}\ndata: ${JSON.stringify(index === 24 ? { kind: "done", text: "abcdefghijklmnopqrstuvwx" } : { kind: "delta", text: String.fromCharCode(97 + index) })}\n\n`,
						).join(""),
					);
				};
				const response = mountEmbeddedCapability(request(), backend);
				const socket = (
					response as Response & {
						webSocket?: (WebSocket & { accept(): void }) | null;
					}
				).webSocket;
				if (!socket) throw new Error("upgrade returned no client socket");
				socket.accept();
				return authenticateEmbeddedSocket(socket, "signed");
			},
		);
		const ids: string[] = [];
		let text = "";
		let active = 0;
		let maximum = 0;
		try {
			await client.stream(
				{ clientRequestId: "ordered-stream", text: "hello" },
				async (frame) => {
					maximum = Math.max(maximum, ++active);
					const index = Number(frame.id?.slice(runId.length + 1));
					await new Promise((resolve) => setTimeout(resolve, (25 - index) % 4));
					ids.push(frame.id!);
					if (frame.event.kind === "delta") text += frame.event.text;
					if (frame.event.kind === "done") expect(text).toBe(frame.event.text);
					active--;
				},
			);
			expect(maximum).toBe(1);
			expect(ids).toEqual(
				Array.from({ length: 25 }, (_, index) => `${runId}:${index}`),
			);
			expect(text).toBe("abcdefghijklmnopqrstuvwx");
			expect(requests).toEqual([
				{ resume: false, lastEventId: undefined },
				{ resume: true, lastEventId: `${runId}:11` },
			]);
		} finally {
			client.dispose();
		}
	});
});
