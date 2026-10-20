import { describe, it, expect } from "vite-plus/test";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import {
	isAuthRecoveryError,
	isTransportRecoveryError,
	authRecoveryMessageFromResult,
} from "./recovery";
describe("recovery", () => {
	it("recognizes beta.3 branded SDK auth failures without parsing text", () => {
		expect(isAuthRecoveryError(new UnauthorizedError("opaque"))).toBe(true);
	});
	it("distinguishes transport failures from application failures", () => {
		expect(isTransportRecoveryError(new Error("fetch failed"))).toBe(true);
		expect(isTransportRecoveryError(new Error("MCP failed (503)"))).toBe(false);
		expect(isTransportRecoveryError(new Error("MCP status 503"))).toBe(true);
		expect(isTransportRecoveryError(new Error("invalid arguments"))).toBe(
			false,
		);
	});
	it("finds scope failures in cyclic structured results without treating all errors as auth", () => {
		const result: Record<string, unknown> = {
			content: [{ text: "Required scopes are missing: read" }],
		};
		result.self = result;
		expect(authRecoveryMessageFromResult(result)).toBe(
			"Required scopes are missing: read",
		);
		expect(
			authRecoveryMessageFromResult({
				content: [{ text: "invalid arguments" }],
			}),
		).toBeNull();
	});
});
