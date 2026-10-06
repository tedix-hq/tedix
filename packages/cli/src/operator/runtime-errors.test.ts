import { describe, expect, test } from "bun:test";
import {
	isAuthError,
	isConnectionError,
	isRecoverableTurnError,
} from "./runtime-errors.ts";

describe("isConnectionError", () => {
	test("flags transport/connection drops", () => {
		for (const msg of [
			"connection closed",
			"transport closed",
			"not connected",
			"network timeout",
			"socket hang up",
			"fetch failed",
			"ECONNRESET",
			"EPIPE",
			"HTTP 503 Service Unavailable",
			"HTTP 502 Bad Gateway",
			"D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
		]) {
			expect(isConnectionError(new Error(msg))).toBe(true);
		}
	});

	test("does not flag a validation/business failure", () => {
		expect(isConnectionError(new Error("conversation not found"))).toBe(false);
		expect(isConnectionError(new Error("HTTP 400 Bad Request"))).toBe(false);
	});

	test("handles non-Error throwables via String()", () => {
		expect(isConnectionError("network unreachable")).toBe(true);
		expect(isConnectionError({})).toBe(false);
	});
});

describe("isAuthError", () => {
	test("flags 401 / unauthorized / expired-token", () => {
		for (const msg of [
			"HTTP 401 Unauthorized",
			"unauthorized",
			"invalid token provided",
			"invalid or expired session",
			"token expired",
			"authentication failed",
		]) {
			expect(isAuthError(new Error(msg))).toBe(true);
		}
	});

	test("does NOT flag 403 (scope/rate-limit, not a bad token)", () => {
		expect(isAuthError(new Error("HTTP 403 Forbidden"))).toBe(false);
		expect(isAuthError(new Error("forbidden"))).toBe(false);
	});

	test("does NOT flag connection errors", () => {
		expect(isAuthError(new Error("connection closed"))).toBe(false);
		expect(isAuthError(new Error("network timeout"))).toBe(false);
	});
});

describe("isRecoverableTurnError", () => {
	test("recovers a blocking ask timeout", () => {
		expect(isRecoverableTurnError(new Error("ASK_HOME_TIMEOUT"))).toBe(true);
	});

	test("recovers a JSON-RPC request-timeout (-32001)", () => {
		expect(
			isRecoverableTurnError(new Error("RPC error -32001: request timed out")),
		).toBe(true);
	});

	test("recovers transport/connection drops via isConnectionError", () => {
		for (const msg of [
			"connection closed",
			"fetch failed",
			"socket hang up",
			"ECONNRESET",
			"HTTP 503 Service Unavailable",
			"HTTP 502 Bad Gateway",
			"D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
		]) {
			expect(isRecoverableTurnError(new Error(msg))).toBe(true);
		}
	});

	test("does NOT recover a genuine validation/business failure", () => {
		expect(isRecoverableTurnError(new Error("conversation not found"))).toBe(
			false,
		);
		expect(isRecoverableTurnError(new Error("HTTP 400 Bad Request"))).toBe(
			false,
		);
	});

	test("handles non-Error throwables via String()", () => {
		expect(isRecoverableTurnError("network unreachable")).toBe(true);
		expect(isRecoverableTurnError({})).toBe(false);
	});

	test("an auth-shaped timeout is recoverable but must be auth-gated by callers", () => {
		const err = new Error("HTTP 401 Unauthorized — request timed out");
		expect(isAuthError(err)).toBe(true);
		expect(isRecoverableTurnError(err)).toBe(true);
		expect(!isAuthError(err) && isRecoverableTurnError(err)).toBe(false);
	});
});
