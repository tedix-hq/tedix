import { describe, expect, it } from "vite-plus/test";
import { hasWorkAcceptanceScope, WORK_ACCEPT_SCOPE } from "./policy-helpers";

type ScopeContext = Parameters<typeof hasWorkAcceptanceScope>[0];

function scopeContext(scopes?: string[], tediScopes?: string[]): ScopeContext {
	return {
		apiKey: scopes ? ({ scopes } as ScopeContext["apiKey"]) : undefined,
		tediScopes,
	};
}

describe("work acceptance scope", () => {
	it("refuses a credential carrying no scopes at all", () => {
		expect(hasWorkAcceptanceScope(scopeContext())).toBe(false);
		expect(hasWorkAcceptanceScope(scopeContext([]))).toBe(false);
	});

	// The whole point of a dedicated scope: acceptance is what makes a Work Item
	// executable, so the DEFAULT agent credential must not carry it. `tedix agent
	// start` grants platform:admin by default — if that were sufficient, every coding
	// harness could make its own work executable the moment it was created, and
	// the scope would be decorative.
	it("does not accept platform:admin, the default agent scope", () => {
		expect(hasWorkAcceptanceScope(scopeContext(["platform:admin"]))).toBe(
			false,
		);
		expect(
			hasWorkAcceptanceScope(scopeContext(undefined, ["platform:admin"])),
		).toBe(false);
	});

	it("accepts the dedicated scope, however the credential carries it", () => {
		expect(hasWorkAcceptanceScope(scopeContext([WORK_ACCEPT_SCOPE]))).toBe(
			true,
		);
		expect(
			hasWorkAcceptanceScope(scopeContext(undefined, [WORK_ACCEPT_SCOPE])),
		).toBe(true);
		expect(
			hasWorkAcceptanceScope(
				scopeContext(["platform:admin", WORK_ACCEPT_SCOPE]),
			),
		).toBe(true);
	});

	it("requires the dedicated capability even for broad credentials", () => {
		expect(hasWorkAcceptanceScope(scopeContext(["*"]))).toBe(false);
		expect(hasWorkAcceptanceScope(scopeContext(["platform:admin"]))).toBe(
			false,
		);
	});

	// A near-miss must not pass: scope checks are exact membership, never prefix
	// or substring matching.
	it("refuses near-miss scope names", () => {
		for (const near of [
			"work",
			"work:",
			"work:accept:all",
			"workaccept",
			"accept",
			"work:acceptance",
		]) {
			expect(hasWorkAcceptanceScope(scopeContext([near])), near).toBe(false);
		}
	});
});
