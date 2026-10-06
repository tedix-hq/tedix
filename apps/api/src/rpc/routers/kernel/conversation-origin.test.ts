import { describe, expect, it } from "vite-plus/test";
import {
	defaultHomeConversationIdForCaller,
	kernelConversationOriginFromPayload,
	MAIN_HOME_CONVERSATION_ID,
	resolveKernelConversationOrigin,
} from "./conversation-origin";

/**
 * The classification rule behind the origin stamp. What this suite pins is the
 * asymmetry: `agent` needs positive evidence, `human` is what everything else
 * decays to. Getting that backwards hides the operator's own conversations.
 */

function ctx(
	overrides: Partial<{
		authType:
			| "user"
			| "m2m"
			| "apikey"
			| "tedi"
			| "service-binding"
			| undefined;
		externalAgentPrincipalId: string;
		headers: Record<string, string>;
	}> = {},
) {
	return {
		authType: overrides.authType,
		externalAgentPrincipalId: overrides.externalAgentPrincipalId,
		headers: new Headers(overrides.headers ?? {}),
	};
}

describe("resolveKernelConversationOrigin", () => {
	it("classifies a Tedix OS operator (User JWT, no MCP edge) as human", () => {
		expect(resolveKernelConversationOrigin(ctx({ authType: "user" }))).toBe(
			"human",
		);
	});

	it("classifies every machine principal class as agent", () => {
		for (const authType of [
			"apikey",
			"m2m",
			"tedi",
			"service-binding",
		] as const) {
			expect(resolveKernelConversationOrigin(ctx({ authType }))).toBe("agent");
		}
	});

	it("classifies a verified external coding agent as agent", () => {
		expect(
			resolveKernelConversationOrigin(
				ctx({
					authType: "service-binding",
					externalAgentPrincipalId: "8f1b0f9e-0f1a-4c3d-8b2e-0d9c7a6b5e4f",
				}),
			),
		).toBe("agent");
	});

	/**
	 * The case `authType` alone gets wrong. `tedix ask`, Code Mode, and MCP
	 * smoke tests replay the operator's own OAuth token, so apps/api sees
	 * `authType: "user"` — the MCP edge's per-execution tool-id header is what
	 * separates a programmatic call from someone typing in a browser.
	 */
	it("classifies a user token replayed through the MCP edge as agent", () => {
		expect(
			resolveKernelConversationOrigin(
				ctx({
					authType: "user",
					headers: { "X-Tedix-Mcp-Tool-Id": "ask" },
				}),
			),
		).toBe("agent");
	});

	/**
	 * The retired frontend's forwarded-human contract, header for header.
	 * Caller-type must therefore
	 * NOT be treated as an MCP marker.
	 */
	it("does not treat the shared mcp-edge-user caller type as an agent marker", () => {
		expect(
			resolveKernelConversationOrigin(
				ctx({
					authType: "user",
					headers: { "X-Tedix-Caller-Type": "mcp-edge-user" },
				}),
			),
		).toBe("human");
	});

	it("falls back to human for an unclassified context", () => {
		expect(resolveKernelConversationOrigin(ctx())).toBe("human");
	});
});

describe("kernelConversationOriginFromPayload", () => {
	it("reads a stamped payload", () => {
		expect(kernelConversationOriginFromPayload({ origin: "agent" })).toBe(
			"agent",
		);
		expect(kernelConversationOriginFromPayload({ origin: "human" })).toBe(
			"human",
		);
	});

	it("returns null — not a default — for an unstamped or junk payload", () => {
		expect(kernelConversationOriginFromPayload(undefined)).toBeNull();
		expect(kernelConversationOriginFromPayload({ role: "user" })).toBeNull();
		expect(kernelConversationOriginFromPayload({ origin: "robot" })).toBeNull();
		expect(kernelConversationOriginFromPayload({ origin: 7 })).toBeNull();
	});
});

/**
 * Where an absent conversationId sends a write. Machine callers must not
 * inherit `home:main`, or a Code Mode probe's turn lands in the operator's own
 * transcript; the caller is classified by authenticated-principal metadata,
 * not by message text. What matters is that a human still lands on `home:main`
 * (a false `agent` would hide the operator's own message from them) and that an
 * agent never does.
 */
describe("defaultHomeConversationIdForCaller", () => {
	it("sends a Tedix OS operator to the main Home thread", () => {
		expect(defaultHomeConversationIdForCaller(ctx({ authType: "user" }))).toBe(
			MAIN_HOME_CONVERSATION_ID,
		);
	});

	it("sends an unclassifiable caller to the main thread, never a hidden one", () => {
		// Fail-safe direction: synthetic and Durable-Object contexts have no
		// authType, and hiding a turn is worse than one noisy sidebar row.
		expect(defaultHomeConversationIdForCaller(ctx())).toBe(
			MAIN_HOME_CONVERSATION_ID,
		);
	});

	it("keeps every machine principal class OFF the main thread", () => {
		for (const authType of [
			"apikey",
			"m2m",
			"tedi",
			"service-binding",
		] as const) {
			const id = defaultHomeConversationIdForCaller(ctx({ authType }));
			expect(id).not.toBe(MAIN_HOME_CONVERSATION_ID);
			expect(id.startsWith("home:agent:")).toBe(true);
		}
	});

	it("keeps an MCP-edge-replayed user token (Code Mode, smoke tests) off the main thread", () => {
		// The exact case that polluted the operator's transcript: the underlying
		// credential is the operator's own OAuth session, but the call is
		// programmatic.
		expect(
			defaultHomeConversationIdForCaller(
				ctx({
					authType: "user",
					headers: { "X-Tedix-Mcp-Tool-Id": "ask" },
				}),
			),
		).toBe("home:agent:mcp");
	});

	it("scopes a coding agent to its own principal so its follow-up turns stay coherent", () => {
		expect(
			defaultHomeConversationIdForCaller(
				ctx({
					authType: "service-binding",
					externalAgentPrincipalId: "5eed0015-0000-4000-8000-000000000015",
				}),
			),
		).toBe("home:agent:5eed0015-0000-4000-8000-000000000015");
	});

	it("stays inside the home: namespace so the key still routes to the kernel store", () => {
		// The retired frontend routed kernel conversations by the `home:` prefix alone
		// (isKernelConversationKey); an agent-scoped key that lost it would be
		// read as a per-tedi runtime conversation.
		expect(
			defaultHomeConversationIdForCaller(ctx({ authType: "apikey" })),
		).toMatch(/^home:/);
	});
});
