import { describe, expect, it, vi } from "vite-plus/test";
import {
	EMBEDDED_STREAM_EXPIRY_GRACE_MS,
	EmbeddedRoot,
	EmbeddedSession,
	scopedTurnKey,
	type EmbeddedCapabilityAdapter,
} from "./embedded-capability";

function fixture() {
	let authorized = true;
	const calls: Array<{ path: string; body: unknown }> = [];
	const authority = {
		sessionKey: "company-8042-user-6190-conversation-1",
		subject: "demo-user",
		tenant: "acme:company-8042",
		origin: "https://www.acme.example",
		expiresAt: Date.now() + 60_000,
	};
	const adapter: EmbeddedCapabilityAdapter = {
		authorize: async (token) => {
			if (!authorized || token !== "valid") throw new Error("Forbidden");
			return authority;
		},
		stream: async () => Response.json({ ok: true }),
		readTranscript: async (token) => {
			calls.push({ path: "readTranscript", body: { token } });
			return { messages: [{ role: "assistant", content: "Welcome back" }] };
		},
		readCompletedTurn: async (token, input) => {
			calls.push({ path: "readCompletedTurn", body: { token, ...input } });
			return { text: "Current answer" };
		},
		cancel: async (_token, turnKey) => {
			calls.push({ path: "cancel", body: { client_request_id: turnKey } });
			return { ok: true };
		},
		listApprovals: async () => ({ ok: true }),
		requestApproval: async (_token, description) => {
			calls.push({ path: "requestApproval", body: { description } });
			return { ok: true };
		},
		resolveApproval: async () => ({ ok: true }),
		pin: async (_token, summary, pageContext) => {
			calls.push({ path: "pin", body: { summary, pageContext } });
			return { ok: true };
		},
		metrics: async (_token, input) => {
			calls.push({ path: "clientMilestones", body: input });
		},
		callPortableTool: async (_token, input) => {
			calls.push({ path: "portableTool", body: input });
			return { ok: true };
		},
		rankPortableTools: async (_token, input) => {
			calls.push({ path: "rankPortableTools", body: input });
			return {
				rankedIds: [...input.callables].reverse(),
				receipt: {
					executionId: "11111111-1111-4111-8111-111111111111",
					usagePersistence: "persisted",
				},
			};
		},
		listConversationCapabilities: async () => ({
			attached: [],
			available: [],
			authority: "context_only",
		}),
		attachConversationCapability: async (_token, input) => {
			calls.push({ path: "attachCapability", body: input });
			return {
				capability: {
					id: "11111111-1111-4111-8111-111111111111",
					capabilityId: input.capabilityId,
					replayName: input.replayName,
					name: "Research",
					slug: "research",
					whyPresent: { type: "user", actorId: "demo-user", attachedAt: "now" },
					authority: "context_only",
				},
			};
		},
		detachConversationCapability: async (_token, referenceId) => {
			calls.push({ path: "detachCapability", body: { referenceId } });
			return { detached: true, referenceId };
		},
		listConversationArtifactPins: async () => ({ pins: [] }),
		attachConversationArtifactPin: async (_token, input) => {
			calls.push({ path: "attachArtifactPin", body: input });
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
					whyPresent: { type: "user", actorId: "demo-user", attachedAt: "now" },
					authority: "context_only",
				},
			};
		},
		detachConversationArtifactPin: async (_token, pinId) => {
			calls.push({ path: "detachArtifactPin", body: { pinId } });
			return { detached: true, pinId };
		},
		runId: (key) => "tedi:chat:" + key,
	};
	return {
		adapter,
		authority,
		calls,
		revoke: () => {
			authorized = false;
		},
	};
}
describe("embedded capability boundary", () => {
	it("reports server-derived stream timing and isolates observer failures", async () => {
		const f = fixture();
		const wire = pacedRuntimeResponse();
		f.adapter.stream = async () => wire.response;
		const observe = vi.fn((_timing: unknown) => {
			throw new Error("diagnostic sink failed");
		});
		f.adapter.observeStream = observe;
		const session = new EmbeddedSession(f.adapter, "valid", f.authority);
		const delivered: string[] = [];
		const done = session.stream(
			{ text: "question", clientRequestId: "timing-test" },
			async (frame) => {
				delivered.push(String(frame.event.kind));
			},
		);
		wire.frame("frame:1", { kind: "delta", text: "answer" });
		wire.frame("frame:2", { kind: "done", text: "answer" });
		wire.end();
		await done;
		expect(delivered).toEqual(["delta", "done"]);
		expect(observe).toHaveBeenCalledOnce();
		const timing = observe.mock.calls[0]?.[0] as unknown as {
			runId: string;
			outcome: string;
			acknowledged: number;
		};
		expect(timing.runId).toBe(
			f.adapter.runId(await scopedTurnKey(f.authority, "timing-test")),
		);
		expect(timing.outcome).toBe("completed");
		expect(timing.acknowledged).toBe(2);
		session[Symbol.dispose]();
	});

	it("reads the signed transcript and rechecks revoked access", async () => {
		const f = fixture();
		const session = new EmbeddedSession(f.adapter, "valid", { ...f.authority });
		expect(await session.readTranscript()).toEqual({
			messages: [{ role: "assistant", content: "Welcome back" }],
		});
		f.revoke();
		await expect(session.readTranscript()).rejects.toThrow("Forbidden");
		expect(f.calls).toEqual([
			{ path: "readTranscript", body: { token: "valid" } },
		]);
		session[Symbol.dispose]();
	});
	it("derives a completed-turn read from the signed identity and exact request", async () => {
		const f = fixture();
		const session = new EmbeddedSession(f.adapter, "valid", { ...f.authority });
		expect(await session.readCompletedTurn("request-current")).toEqual({
			text: "Current answer",
		});
		expect(f.calls).toEqual([
			{
				path: "readCompletedTurn",
				body: {
					token: "valid",
					runId: f.adapter.runId(
						await scopedTurnKey(f.authority, "request-current"),
					),
				},
			},
		]);
		await expect(session.readCompletedTurn("bad id")).rejects.toThrow(
			"Invalid request id",
		);
		f.revoke();
		await expect(session.readCompletedTurn("request-current")).rejects.toThrow(
			"Forbidden",
		);
		session[Symbol.dispose]();
	});
	it.each(["sessionKey", "subject", "tenant", "origin"] as const)(
		"rejects transcript reads after %s changes",
		async (key) => {
			const f = fixture();
			const session = new EmbeddedSession(f.adapter, "valid", {
				...f.authority,
			});
			f.authority[key] += "-changed";
			await expect(session.readTranscript()).rejects.toThrow(
				"Session identity changed",
			);
			expect(f.calls).toEqual([]);
		},
	);
	it("forwards a well-formed model choice and drops a malformed one", async () => {
		// The browser may ASK for a model and an effort; this boundary only checks
		// that the values could be a ref and an effort. What the session may
		// actually route at is decided downstream against the tedi's model
		// catalog, so a forged ref can reach the adapter but never widen spend.
		const f = fixture();
		const seen: Array<Record<string, unknown>> = [];
		f.adapter.stream = async (_token, input) => {
			seen.push(input as unknown as Record<string, unknown>);
			return Response.json({ ok: true });
		};
		const session = new EmbeddedSession(f.adapter, "valid", f.authority);
		await session
			.stream(
				{
					clientRequestId: "pick-1234",
					text: "hi",
					modelRef: "azure-openai/gpt-5.6-terra",
					reasoningEffort: "high",
				},
				async () => {},
			)
			.catch(() => {});
		expect(seen[0]?.modelRef).toBe("azure-openai/gpt-5.6-terra");
		expect(seen[0]?.reasoningEffort).toBe("high");

		const second = new EmbeddedSession(f.adapter, "valid", f.authority);
		await second
			.stream(
				{
					clientRequestId: "pick-5678",
					text: "hi",
					modelRef: "not a ref at all",
					reasoningEffort: "ludicrous",
				},
				async () => {},
			)
			.catch(() => {});
		expect(seen[1]).toBeDefined();
		expect(seen[1]).not.toHaveProperty("modelRef");
		expect(seen[1]).not.toHaveProperty("reasoningEffort");
		session[Symbol.dispose]();
		second[Symbol.dispose]();
	});
	it("marks stream expiry before dispatch and never calls the adapter", async () => {
		const f = fixture();
		const session = new EmbeddedSession(f.adapter, "valid", f.authority, {
			now: () => f.authority.expiresAt,
		});
		await expect(
			session.stream(
				{ clientRequestId: "expired", text: "read" },
				async () => {},
			),
		).rejects.toThrow("Session expired before stream dispatch");
		expect(f.calls).toEqual([]);
		session[Symbol.dispose]();
	});
	it("rejects transcript reads at expiry without using stream grace", async () => {
		const f = fixture();
		const session = new EmbeddedSession(f.adapter, "valid", f.authority, {
			now: () => f.authority.expiresAt,
		});
		await expect(session.readTranscript()).rejects.toThrow("Session expired");
		expect(f.calls).toEqual([]);
		session[Symbol.dispose]();
	});
	it("validates artifact pin mutations before the signed adapter call", async () => {
		const f = fixture();
		const session = new EmbeddedSession(f.adapter, "valid", f.authority);
		const pinId = "33333333-3333-4333-8333-333333333333";
		await session.attachConversationArtifactPin({
			artifactId: "artifact-1",
			replayName: "approved_report",
		});
		await session.detachConversationArtifactPin(pinId);
		expect(f.calls).toContainEqual({
			path: "attachArtifactPin",
			body: { artifactId: "artifact-1", replayName: "approved_report" },
		});
		await expect(
			session.attachConversationArtifactPin({
				artifactId: "",
				replayName: "Bad",
			}),
		).rejects.toThrow("Invalid conversation artifact pin");
	});
	it("validates named capability mutations before the signed adapter call", async () => {
		const f = fixture();
		const session = new EmbeddedSession(f.adapter, "valid", f.authority);
		const capabilityId = "22222222-2222-4222-8222-222222222222";
		const referenceId = "11111111-1111-4111-8111-111111111111";

		await session.attachConversationCapability({
			capabilityId,
			replayName: "customer_research",
		});
		await session.detachConversationCapability(referenceId);

		expect(f.calls).toContainEqual({
			path: "attachCapability",
			body: { capabilityId, replayName: "customer_research" },
		});
		expect(f.calls).toContainEqual({
			path: "detachCapability",
			body: { referenceId },
		});
		await expect(
			session.attachConversationCapability({
				capabilityId,
				replayName: "Not valid",
			}),
		).rejects.toThrow("Invalid conversation capability");
		session[Symbol.dispose]();
	});
	it("never dispatches an operation before successful authentication", async () => {
		const f = fixture();
		const root = new EmbeddedRoot(f.adapter);
		await expect(root.authenticate("invalid")).rejects.toThrow("Forbidden");
		expect(f.calls).toHaveLength(0);
		await expect(root.authenticate("valid")).rejects.toThrow(
			"Authentication unavailable",
		);
		root[Symbol.dispose]();
	});
	it("reauthorizes every call and does not dispatch revoked credentials", async () => {
		const f = fixture();
		const root = new EmbeddedRoot(f.adapter);
		const session = await root.authenticate("valid");
		await session.pin("Approved summary");
		expect(f.calls).toHaveLength(1);
		f.revoke();
		await expect(session.pin("Must not save")).rejects.toThrow("Forbidden");
		expect(f.calls).toHaveLength(1);
		root[Symbol.dispose]();
	});
	it("binds idempotency and cancellation keys to the user and conversation", async () => {
		const f = fixture();
		const key = await scopedTurnKey(f.authority, "request_1234");
		expect(await scopedTurnKey(f.authority, "request_1234")).toBe(key);
		expect(
			await scopedTurnKey(
				{ ...f.authority, sessionKey: "other-conversation" },
				"request_1234",
			),
		).not.toBe(key);
		expect(
			await scopedTurnKey(
				{ ...f.authority, subject: "other-user" },
				"request_1234",
			),
		).not.toBe(key);
		expect(
			await scopedTurnKey(
				{ ...f.authority, tenant: "acme:company-1" },
				"request_1234",
			),
		).not.toBe(key);
		expect(
			await scopedTurnKey(
				{ ...f.authority, origin: "https://evil.example" },
				"request_1234",
			),
		).not.toBe(key);
		const root = new EmbeddedRoot(f.adapter);
		const session = await root.authenticate("valid");
		await session.cancel("request_1234");
		expect(f.calls[0]).toEqual({
			path: "cancel",
			body: { client_request_id: key },
		});
		await expect(
			session.stream(
				{
					text: "test",
					clientRequestId: "request_1234",
					resume: true,
					lastEventId: "foreign:chat:run:1",
				},
				async () => {},
			),
		).rejects.toThrow("Cursor");
		expect(f.calls).toHaveLength(1);
		root[Symbol.dispose]();
	});
	it("refuses operations after expiry and after disposal", async () => {
		const f = fixture();
		const root = new EmbeddedRoot(f.adapter);
		const session = await root.authenticate("valid");
		f.authority.expiresAt = Date.now() - 1;
		await expect(session.listApprovals()).rejects.toThrow("Session expired");
		root[Symbol.dispose]();
		expect(f.calls).toHaveLength(0);
	});
	it("creates only a bounded explicit approval request", async () => {
		const f = fixture();
		const root = new EmbeddedRoot(f.adapter);
		const session = await root.authenticate("valid");
		await session.requestApproval("  Confirm the no-op validation  ");
		expect(f.calls).toEqual([
			{
				path: "requestApproval",
				body: { description: "Confirm the no-op validation" },
			},
		]);
		await expect(session.requestApproval(" ")).rejects.toThrow(
			"Invalid approval request",
		);
		root[Symbol.dispose]();
	});
	it("accepts only bounded explicit portable discovery without executing a tool", async () => {
		const f = fixture();
		const root = new EmbeddedRoot(f.adapter);
		const session = await root.authenticate("valid");
		expect(
			await session.rankPortableTools({
				query: "  list open orders  ",
				callables: ["acme.list_orders", "acme.get_order"],
			}),
		).toEqual({
			rankedIds: ["acme.get_order", "acme.list_orders"],
			receipt: {
				executionId: "11111111-1111-4111-8111-111111111111",
				usagePersistence: "persisted",
			},
		});
		expect(f.calls).toEqual([
			{
				path: "rankPortableTools",
				body: {
					query: "list open orders",
					callables: ["acme.list_orders", "acme.get_order"],
				},
			},
		]);
		await expect(
			session.rankPortableTools({
				query: "find",
				callables: ["acme.get_order", "acme.get_order"],
			}),
		).rejects.toThrow("Invalid portable tool discovery");
		await expect(
			session.rankPortableTools({
				query: "find",
				callables: ["acme.get_order", "other.bad;drop"],
			}),
		).rejects.toThrow("Invalid portable tool discovery");
		root[Symbol.dispose]();
	});
	it("does not expose an unconfigured automatic business read or outcome capability", async () => {
		const f = fixture();
		const root = new EmbeddedRoot(f.adapter);
		const session = await root.authenticate("valid");
		expect("getAttentionBrief" in session).toBe(false);
		expect("recordAttentionOutcome" in session).toBe(false);
		expect(f.calls).toEqual([]);
		root[Symbol.dispose]();
	});
});

/** A runtime SSE body whose frames are released one at a time by the test. */
function pacedRuntimeResponse() {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start: (c) => {
			controller = c;
		},
	});
	return {
		response: new Response(body, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		}),
		frame(id: string, event: Record<string, unknown>) {
			controller.enqueue(
				encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`),
			);
		},
		end() {
			controller.close();
		},
	};
}

describe("embedded capability stream expiry", () => {
	function streamFixture(
		options: {
			reauthorizedExpiresAt?: (base: number) => number;
		} = {},
	) {
		const base = fixture();
		let now = 1_000_000;
		const authority = { ...base.authority, expiresAt: now + 10_000 };
		const authorizeCalls: number[] = [];
		const wire = pacedRuntimeResponse();
		const adapter: EmbeddedCapabilityAdapter = {
			...base.adapter,
			authorize: async (token) => {
				authorizeCalls.push(now);
				if (token !== "valid") throw new Error("Forbidden");
				// Re-verifying the SAME token yields the same expiry unless the
				// adapter has clock tolerance / a rotated credential (opt-in below).
				return options.reauthorizedExpiresAt
					? {
							...authority,
							expiresAt: options.reauthorizedExpiresAt(authority.expiresAt),
						}
					: authority;
			},
			stream: async () => wire.response,
		};
		const session = new EmbeddedSession(adapter, "valid", authority, {
			now: () => now,
		});
		return {
			session,
			wire,
			authority,
			authorizeCalls,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	it("keeps delivering frames past expiresAt inside the grace window and re-authorizes once", async () => {
		const f = streamFixture();
		const delivered: string[] = [];
		const done = f.session.stream(
			{ text: "long turn", clientRequestId: "request_1234" },
			async (frame) => {
				delivered.push(String(frame.event.kind));
			},
		);
		f.wire.frame("run:1", { kind: "delta", text: "A" });
		await vi.waitFor(() => expect(delivered).toHaveLength(1));
		// The credential expires while the model is still generating.
		f.advance(10_001);
		f.wire.frame("run:2", { kind: "delta", text: "B" });
		await vi.waitFor(() => expect(delivered).toHaveLength(2));
		f.wire.frame("run:3", { kind: "done", text: "AB" });
		f.wire.end();
		await done;
		expect(delivered).toEqual(["delta", "delta", "done"]);
		// One authorize for `#check`, exactly one more at expiry — not per frame.
		expect(f.authorizeCalls).toHaveLength(2);
		f.session[Symbol.dispose]();
	});

	it("cuts an in-flight stream only past the grace window, with the exact expiry message", async () => {
		const f = streamFixture();
		const delivered: string[] = [];
		const done = f.session.stream(
			{ text: "very long turn", clientRequestId: "request_1234" },
			async (frame) => {
				delivered.push(String(frame.event.kind));
			},
		);
		f.wire.frame("run:1", { kind: "delta", text: "A" });
		await vi.waitFor(() => expect(delivered).toHaveLength(1));
		f.advance(10_000 + EMBEDDED_STREAM_EXPIRY_GRACE_MS);
		f.wire.frame("run:2", { kind: "delta", text: "B" });
		await expect(done).rejects.toThrow("Session expired");
		expect(delivered).toEqual(["delta"]);
		f.session[Symbol.dispose]();
	});

	it("extends the session when re-authorization returns a later expiresAt", async () => {
		const f = streamFixture({
			reauthorizedExpiresAt: (expiresAt) => expiresAt + 600_000,
		});
		const delivered: string[] = [];
		const done = f.session.stream(
			{ text: "long turn", clientRequestId: "request_1234" },
			async (frame) => {
				delivered.push(String(frame.event.kind));
			},
		);
		f.wire.frame("run:1", { kind: "delta", text: "A" });
		await vi.waitFor(() => expect(delivered).toHaveLength(1));
		f.advance(10_001);
		f.wire.frame("run:2", { kind: "delta", text: "B" });
		await vi.waitFor(() => expect(delivered).toHaveLength(2));
		// Well past the ORIGINAL hard deadline; the refreshed authority carries it.
		f.advance(EMBEDDED_STREAM_EXPIRY_GRACE_MS * 2);
		f.wire.frame("run:3", { kind: "done", text: "AB" });
		f.wire.end();
		await done;
		expect(delivered).toEqual(["delta", "delta", "done"]);
		f.session[Symbol.dispose]();
	});

	it("still refuses a NEW operation at expiresAt exactly", async () => {
		const f = streamFixture();
		f.advance(10_000);
		await expect(f.session.listApprovals()).rejects.toThrow("Session expired");
		f.session[Symbol.dispose]();
	});
});
