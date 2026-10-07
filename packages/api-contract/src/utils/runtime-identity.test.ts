import { describe, expect, it } from "vite-plus/test";
import {
	agentSessionKeyWasExpanded,
	buildRuntimeRunId,
	buildRuntimeWorkflowInstanceId,
	buildTediConversationId,
	canonicalizeAgentSessionKey,
	DEFAULT_TEDI_SESSION_KEY,
	EVIDENCE_JUDGE_SESSION_PREFIX,
	isBlindVerificationSession,
	isEphemeralSessionKey,
	isLeanContextSession,
	isReplyDraftSession,
	parseRuntimeRunSurface,
	REPLY_DRAFT_SESSION_PREFIX,
	RUNTIME_CONTROL_ID_RE,
	resolveRuntimeSessionKey,
	sanitizeRuntimeTurnKey,
	sessionKeyFromTediConversationId,
} from "./runtime-identity";

const TEDI_ID = "5eed0042-0000-4000-8000-000000000042";

describe("runtime identity helpers", () => {
	it("builds body-neutral runtime run ids from stable turn keys", () => {
		expect(buildRuntimeRunId({ tediId: TEDI_ID, turnKey: "abc" })).toBe(
			`${TEDI_ID}:chat:abc`,
		);
		expect(
			buildRuntimeRunId({ tediId: TEDI_ID, turnKey: "a:b:c", surface: "mcp" }),
		).toBe(`${TEDI_ID}:mcp:a_b_c`);
		expect(
			buildRuntimeRunId({
				tediId: TEDI_ID,
				turnKey: "<msg-123@mail.example>",
				surface: "chat",
			}),
		).toBe(`${TEDI_ID}:chat:msg-123@mail.example`);
	});

	it("preserves legacy surface tags when parsing run ids", () => {
		expect(parseRuntimeRunSurface(`${TEDI_ID}:chat:abc`)).toBe("chat");
		expect(parseRuntimeRunSurface(`${TEDI_ID}:mcp:abc`)).toBe("mcp");
		expect(parseRuntimeRunSurface(`${TEDI_ID}:isolate:abc`)).toBe("isolate");
	});

	it("sanitizes stable turn keys without fabricating an empty key", () => {
		expect(sanitizeRuntimeTurnKey("  spaced  id  ")).toBe("spaced_id");
		expect(sanitizeRuntimeTurnKey("<<weird:id>>")).toBe("weird_id");
		expect(() => sanitizeRuntimeTurnKey("<>")).toThrow("empty turnKey");
		expect(sanitizeRuntimeTurnKey("a>b>>")).toBe("a>b");
		const longInnerRun = `a${">".repeat(100_000)}b`;
		const started = performance.now();
		expect(sanitizeRuntimeTurnKey(longInnerRun)).toBe(longInnerRun);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("builds and splits tedi conversation ids", () => {
		expect(
			buildTediConversationId({
				tediRef: "echo",
				sessionKey: "agent:main:qa",
			}),
		).toBe("echo:agent:main:qa");
		expect(buildTediConversationId({ tediRef: "echo" })).toBe(
			`echo:${DEFAULT_TEDI_SESSION_KEY}`,
		);
		expect(
			sessionKeyFromTediConversationId({
				conversationId: "echo:agent:main:qa",
				tediRef: "echo",
			}),
		).toBe("agent:main:qa");
		expect(
			sessionKeyFromTediConversationId({
				conversationId: "echo:agent:main:qa",
			}),
		).toBe("agent:main:qa");
	});

	it("keeps ephemeral validation session detection shared", () => {
		expect(isEphemeralSessionKey("__throwaway:codex")).toBe(true);
		expect(isEphemeralSessionKey("__test:probe")).toBe(true);
		expect(isEphemeralSessionKey("agent:main:main")).toBe(false);
		expect(isEphemeralSessionKey(undefined)).toBe(false);
	});

	// A judge that reads its own memory is not a judge: the runtime recognizes the
	// evidence bridge's session key and injects no accumulated belief into it.
	it("detects blind verification (evidence judge) sessions", () => {
		const judgeKey = `${EVIDENCE_JUDGE_SESSION_PREFIX}run-9:claim-1,claim-2`;
		expect(EVIDENCE_JUDGE_SESSION_PREFIX).toBe("evidence:judge:");
		expect(isBlindVerificationSession(judgeKey)).toBe(true);

		// Normal turns keep their cognition — including the JUDGMENT-writing
		// session that consumes the verdicts. Only the judge itself is blinded.
		expect(isBlindVerificationSession("agent:main:main")).toBe(false);
		expect(isBlindVerificationSession("os:user-42")).toBe(false);
		expect(isBlindVerificationSession("acme:judgment:2026-07-11")).toBe(false);
		expect(isBlindVerificationSession("evidence:summary:run-1")).toBe(false);
		expect(isBlindVerificationSession("my-evidence:judge:spoof")).toBe(false);
		expect(isBlindVerificationSession(EVIDENCE_JUDGE_SESSION_PREFIX)).toBe(
			false,
		);
		expect(isBlindVerificationSession("")).toBe(false);
		expect(isBlindVerificationSession(undefined)).toBe(false);
		expect(isBlindVerificationSession(null)).toBe(false);
	});

	// The triage router's `reply-draft:{requestId}` conversation id reaches the
	// runtime as `agent:main:reply-draft:{requestId}`; that turn runs lean.
	it("detects lean reply-draft sessions", () => {
		const key = `${REPLY_DRAFT_SESSION_PREFIX}5eed0042-0000-4000-8000-000000000001`;
		expect(isReplyDraftSession(key)).toBe(true);
		expect(isLeanContextSession(key)).toBe(true);

		expect(isReplyDraftSession("agent:main:main")).toBe(false);
		expect(isLeanContextSession("agent:main:main")).toBe(false);
		expect(isReplyDraftSession("reply-draft:5eed0042")).toBe(false);
		expect(isReplyDraftSession("agent:main:reply-drafts:x")).toBe(false);
		expect(isReplyDraftSession(REPLY_DRAFT_SESSION_PREFIX)).toBe(false);
		expect(isReplyDraftSession(undefined)).toBe(false);
	});

	it("canonicalizes short agent session keys with an audit predicate", () => {
		const canonical = canonicalizeAgentSessionKey({
			value: "agent:main",
			controlIdPattern: RUNTIME_CONTROL_ID_RE,
			errorLabel: "runtime",
		});
		expect(canonical).toBe("agent:main:main");
		expect(
			agentSessionKeyWasExpanded({
				raw: "agent:main",
				canonical,
			}),
		).toBe(true);
		expect(
			canonicalizeAgentSessionKey({
				value: "os:user-42",
				controlIdPattern: RUNTIME_CONTROL_ID_RE,
			}),
		).toBe("os:user-42");
		expect(() =>
			canonicalizeAgentSessionKey({
				value: "agent::broken",
				controlIdPattern: RUNTIME_CONTROL_ID_RE,
				errorLabel: "runtime",
			}),
		).toThrow("Invalid runtime agent session key");
	});

	it("lowercases agent session keys so runtime and ledger reads agree", () => {
		expect(
			canonicalizeAgentSessionKey({
				value: "agent:MAIN:GATEWAYEVENTBUILDER1781378974964",
				controlIdPattern: RUNTIME_CONTROL_ID_RE,
				errorLabel: "runtime",
			}),
		).toBe("agent:main:gatewayeventbuilder1781378974964");
	});

	it("derives workflowInstanceId from clientRequestId via the dispatch sanitize chain", () => {
		// Typical kernel delegation clientRequestId (contains colons)
		expect(
			buildRuntimeWorkflowInstanceId(
				"9f47295f-abc0-4d1e-b3d2-012345678900:delegate:cto",
			),
		).toBe("9f47295f-abc0-4d1e-b3d2-012345678900_delegate_cto");
		// Plain UUID (no colons after sanitize)
		expect(
			buildRuntimeWorkflowInstanceId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
		).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
		// Long id keeps a prefix but adds a deterministic hash suffix, so two
		// kernel delegation ids sharing the same first 64 chars do not collide.
		const long = "a".repeat(80);
		expect(buildRuntimeWorkflowInstanceId(long)).toMatch(
			/^a{47}-[0-9a-f]{16}$/,
		);
		expect(
			buildRuntimeWorkflowInstanceId(
				"home:runtime-identity-collision-proof:1782653623649:turn",
			),
		).not.toBe(
			buildRuntimeWorkflowInstanceId(
				"home:runtime-identity-collision-proof:1782653561799:turn",
			),
		);
		// Dots (valid in RUNTIME_CONTROL_ID_RE) become underscores
		expect(buildRuntimeWorkflowInstanceId("turn.123.abc")).toBe("turn_123_abc");
	});

	it("resolves runtime session truth from mixed runtime candidates", () => {
		expect(
			resolveRuntimeSessionKey({
				candidates: [undefined, " ", "agent:MAIN:LIVE-TURN"],
			}),
		).toBe("agent:main:live-turn");
		expect(
			resolveRuntimeSessionKey({
				candidates: ["os:user-42", "agent:main:ignored"],
			}),
		).toBe("os:user-42");
		expect(
			resolveRuntimeSessionKey({
				candidates: [null],
				defaultValue: DEFAULT_TEDI_SESSION_KEY,
			}),
		).toBe(DEFAULT_TEDI_SESSION_KEY);
		expect(resolveRuntimeSessionKey({ candidates: [null, ""] })).toBe(
			undefined,
		);
	});
});
