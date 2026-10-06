// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
	isContextUnavailableError,
	toWebMcpFailure,
	webMcpFailureMessage,
} from "@/components/webmcp-execute";

/**
 * Structural fake of the oRPC v2 client `ORPCError`. `@orpc/client` is not a
 * declared dependency of apps/os, so the real class is not importable here. The fake mirrors what the
 * client materializes from the wire envelope — an `Error` subclass carrying
 * `code`/`defined`/`inferable`/`data` — which itself mirrors both the OS
 * worker's proxy refusal (`refuseApi` in `apps/os/src/worker.ts`:
 * `{"json":{"defined":true,"inferable":true,"code":"UNAUTHORIZED","message":…}}`,
 * verified there against a live 401 from api.tedix.dev) and `createError` in
 * `apps/api/src/rpc/orpc.ts`. oRPC v2's `ORPCError` carries no `status` field.
 */
class FakeOrpcError extends Error {
	readonly name = "ORPCError" as const;
	readonly defined = true;
	readonly inferable = true;
	readonly data = undefined;
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

describe("isContextUnavailableError", () => {
	it("classifies UNAUTHORIZED and FORBIDDEN oRPC codes as context loss", () => {
		expect(
			isContextUnavailableError(
				new FakeOrpcError("UNAUTHORIZED", "Authentication required."),
			),
		).toBe(true);
		expect(
			isContextUnavailableError(
				new FakeOrpcError(
					"FORBIDDEN",
					"Organization scope is required. Use an org-scoped credential.",
				),
			),
		).toBe(true);
	});

	it("does not classify other codes or plain errors", () => {
		expect(
			isContextUnavailableError(new FakeOrpcError("CONFLICT", "stale write")),
		).toBe(false);
		expect(
			isContextUnavailableError(
				new FakeOrpcError("NOT_FOUND", "No such output"),
			),
		).toBe(false);
		expect(isContextUnavailableError(new Error("boom"))).toBe(false);
		expect(isContextUnavailableError("boom")).toBe(false);
		expect(isContextUnavailableError(null)).toBe(false);
	});
});

describe("toWebMcpFailure", () => {
	it("maps a session-loss failure to the stable retryable context_unavailable result", () => {
		const result = toWebMcpFailure(
			new FakeOrpcError("UNAUTHORIZED", "Authentication required."),
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: "context_unavailable",
			retryable: true,
			detail: "Authentication required.",
		});
	});

	it("maps an org-scope failure to the same typed shape", () => {
		const result = toWebMcpFailure(
			new FakeOrpcError(
				"FORBIDDEN",
				"Organization scope is required. Use an org-scoped credential.",
			),
		);
		expect(result.structuredContent).toMatchObject({
			error: "context_unavailable",
			retryable: true,
		});
	});

	it("keeps every other failure on the generic message path", () => {
		const conflict = toWebMcpFailure(
			new FakeOrpcError("CONFLICT", "revision moved"),
		);
		expect(conflict.isError).toBe(true);
		expect(conflict.structuredContent).toBeUndefined();
		expect(conflict.content[0]?.text).toBe("revision moved");

		const plain = toWebMcpFailure(new Error("network down"));
		expect(plain.content[0]?.text).toBe("network down");
		expect(plain.structuredContent).toBeUndefined();

		const nonError = toWebMcpFailure("string failure");
		expect(nonError.content[0]?.text).toBe("string failure");
	});
});

describe("webMcpFailureMessage", () => {
	it("stringifies non-Error rejections", () => {
		expect(webMcpFailureMessage(new Error("x"))).toBe("x");
		expect(webMcpFailureMessage(42)).toBe("42");
	});
});
