/**
 * Unit coverage for the PURE helpers exported from the goal-loop Workflow
 * wrapper: the final-assistant-message picker (DESC-first, role filter,
 * empty-content skip, char cap) and the internal service-binding context
 * builder. The Workflow class's `run` method itself is a thin
 * `runGoalLoop` port-wiring shim already covered by `goal-loop.test.ts`'s
 * pure-driver tests; it is not re-exercised here (`cloudflare:workers` is
 * mocked so the module loads under plain-node vitest, same convention as
 * `memory-reflection-workflow.test.ts`).
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { hasRequiredScope } from "../rpc/orpc";

vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
	// `agents/observability/ai` (the span wrapper behind `src/lib/traced-ai.ts`)
	// reads this. Empty selects the wrapper's own no-op tracer, so calls pass
	// through to the AI SDK untraced — spans are a Worker-runtime concern.
	tracing: {},
}));

import {
	FINAL_ASSISTANT_MESSAGE_CHAR_CAP,
	internalKernelContext,
	pickFinalAssistantMessageContent,
} from "./kernel-goal-loop-workflow";

describe("pickFinalAssistantMessageContent", () => {
	it("returns the first assistant row's trimmed content", () => {
		const result = pickFinalAssistantMessageContent([
			{ payload: { role: "assistant", content: "  final answer  " } },
		]);
		expect(result).toBe("final answer");
	});

	it("skips non-assistant rows and picks the first assistant one", () => {
		const result = pickFinalAssistantMessageContent([
			{ payload: { role: "user", content: "ignored" } },
			{ payload: { role: "tool", content: "also ignored" } },
			{ payload: { role: "assistant", content: "the answer" } },
		]);
		expect(result).toBe("the answer");
	});

	it("treats a payload with no role field as assistant-eligible", () => {
		const result = pickFinalAssistantMessageContent([
			{ payload: { content: "no role field" } },
		]);
		expect(result).toBe("no role field");
	});

	it("skips empty/whitespace-only content and keeps scanning", () => {
		const result = pickFinalAssistantMessageContent([
			{ payload: { role: "assistant", content: "   " } },
			{ payload: { role: "assistant", content: "" } },
			{ payload: { role: "assistant", content: "real content" } },
		]);
		expect(result).toBe("real content");
	});

	it("returns null when no row has usable assistant content", () => {
		const result = pickFinalAssistantMessageContent([
			{ payload: { role: "user", content: "hi" } },
			{ payload: { role: "assistant", content: "" } },
			{ payload: null },
		]);
		expect(result).toBeNull();
	});

	it("returns null for an empty row set", () => {
		expect(pickFinalAssistantMessageContent([])).toBeNull();
	});

	it("caps content at FINAL_ASSISTANT_MESSAGE_CHAR_CAP", () => {
		const long = "x".repeat(FINAL_ASSISTANT_MESSAGE_CHAR_CAP + 500);
		const result = pickFinalAssistantMessageContent([
			{ payload: { role: "assistant", content: long } },
		]);
		expect(result).toHaveLength(FINAL_ASSISTANT_MESSAGE_CHAR_CAP);
	});
});

describe("internalKernelContext", () => {
	// `withSession` is the minimum a D1 stub needs: createContext opens one
	// session per request. An empty object used to pass here only because nothing
	// touched the binding — the same too-permissive-double trap that let a
	// db.transaction() call reach production.
	const fakeEnv = {
		DB: { withSession: () => ({ getBookmark: () => null }) },
	} as unknown as CloudflareEnv;

	it("marks the request as a service-binding call", () => {
		const context = internalKernelContext(fakeEnv, "org-1");
		expect(context.headers.get("X-Service-Binding")).toBe("true");
		expect(context.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(context.authType).toBe("service-binding");
		expect(context.organizationId).toBe("org-1");
		expect(context.tediScopes).toEqual(["tedis:write", "tedis:read"]);
		expect(hasRequiredScope(context, "tedis:write")).toBe(true);
		expect(hasRequiredScope(context, "tedis:read")).toBe(true);
		expect(hasRequiredScope(context, "platform:admin")).toBe(false);
	});

	it("pins a different organizationId per call (no shared mutable state)", () => {
		const a = internalKernelContext(fakeEnv, "org-a");
		const b = internalKernelContext(fakeEnv, "org-b");
		expect(a.organizationId).toBe("org-a");
		expect(b.organizationId).toBe("org-b");
		expect(a.headers.get("X-Tedix-Org-Id")).toBe("org-a");
		expect(b.headers.get("X-Tedix-Org-Id")).toBe("org-b");
	});
});
