import { describe, expect, it } from "vite-plus/test";
import {
	errorMessage,
	isAuthorizationError,
	orpcErrorCode,
} from "./orpc-error";

describe("orpcErrorCode", () => {
	it("reads the oRPC code off a thrown client error", () => {
		expect(orpcErrorCode({ code: "FORBIDDEN", message: "nope" })).toBe(
			"FORBIDDEN",
		);
	});

	it("is null for anything that carries no string code", () => {
		expect(orpcErrorCode(new Error("boom"))).toBeNull();
		expect(orpcErrorCode({ code: 403 })).toBeNull();
		expect(orpcErrorCode(null)).toBeNull();
		expect(orpcErrorCode("FORBIDDEN")).toBeNull();
	});
});

describe("isAuthorizationError", () => {
	it("treats refusal codes as authorization, not outage", () => {
		expect(isAuthorizationError({ code: "FORBIDDEN" })).toBe(true);
		expect(isAuthorizationError({ code: "UNAUTHORIZED" })).toBe(true);
	});

	it("leaves real failures alone so they still read as outages", () => {
		expect(isAuthorizationError({ code: "INTERNAL_SERVER_ERROR" })).toBe(false);
		expect(isAuthorizationError({ code: "NOT_FOUND" })).toBe(false);
		expect(isAuthorizationError(new Error("d1 down"))).toBe(false);
	});
});

describe("errorMessage", () => {
	it("prefers the server message", () => {
		expect(errorMessage(new Error("d1 down"))).toBe("d1 down");
		expect(errorMessage({ code: "FORBIDDEN", message: "denied" })).toBe(
			"denied",
		);
	});

	it("never renders an empty or non-string message", () => {
		expect(errorMessage({ message: "   " }, "fallback")).toBe("fallback");
		expect(errorMessage({ message: 42 }, "fallback")).toBe("fallback");
		expect(errorMessage(undefined, "fallback")).toBe("fallback");
	});

	it("accepts a bare string rejection", () => {
		expect(errorMessage("timeout")).toBe("timeout");
	});

	it("does not expose an oRPC parser diagnostic as operator guidance", () => {
		expect(
			errorMessage(
				new Error("Malformed Orpc Error Response"),
				"The provider read failed.",
			),
		).toBe("The provider read failed.");
		expect(
			errorMessage(
				"Malformed Orpc Error Response",
				"The provider read failed.",
			),
		).toBe("The provider read failed.");
	});
});
