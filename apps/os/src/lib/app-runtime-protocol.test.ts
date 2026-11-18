import { describe, expect, it } from "vite-plus/test";
import {
	addAppRuntimeError,
	APP_RUNTIME_MAX_ERROR_BYTES,
	APP_RUNTIME_MAX_ERRORS,
	EMPTY_APP_RUNTIME_ERROR_LOG,
	readAppRuntimeError,
} from "./app-runtime-protocol";

describe("errors a running app reports", () => {
	it("accepts the three kinds with a text message and a client.js line", () => {
		expect(
			readAppRuntimeError({
				kind: "error",
				message: "TypeError: rows is undefined",
				line: 12,
			}),
		).toEqual({
			kind: "error",
			message: "TypeError: rows is undefined",
			line: 12,
		});
		expect(readAppRuntimeError({ kind: "rejection", message: "No" })).toEqual({
			kind: "rejection",
			message: "No",
		});
		expect(readAppRuntimeError({ kind: "console", message: " x " })).toEqual({
			kind: "console",
			message: "x",
		});
	});

	it("drops anything else the page may send", () => {
		for (const params of [
			null,
			"TypeError",
			{ kind: "warning", message: "x" },
			{ kind: "error", message: { text: "x" } },
			{ kind: "error", message: "   " },
		])
			expect(readAppRuntimeError(params)).toBeNull();
		for (const line of [0, -3, 1.5, "12", 5_000_000])
			expect(
				readAppRuntimeError({ kind: "error", message: "x", line }),
			).toEqual({ kind: "error", message: "x" });
	});

	it("cuts a message to 2 KB whatever the page did, without half characters", () => {
		const bytes = (text: string) => new TextEncoder().encode(text).length;
		const long = readAppRuntimeError({
			kind: "console",
			message: "a".repeat(50_000),
		});
		expect(bytes(long!.message)).toBeLessThanOrEqual(
			APP_RUNTIME_MAX_ERROR_BYTES,
		);
		expect(long!.message.endsWith("…")).toBe(true);
		const wide = readAppRuntimeError({
			kind: "console",
			message: "é".repeat(5_000),
		});
		expect(bytes(wide!.message)).toBeLessThanOrEqual(
			APP_RUNTIME_MAX_ERROR_BYTES,
		);
		expect(wide!.message).not.toContain("�");
		expect(
			readAppRuntimeError({ kind: "error", message: "a\u0000b\u001Bc\nd" })
				?.message,
		).toBe("abc\nd");
	});

	it("keeps the count and only the last 20", () => {
		let log = EMPTY_APP_RUNTIME_ERROR_LOG;
		for (let index = 1; index <= 57; index += 1)
			log = addAppRuntimeError(log, {
				kind: "error",
				message: `Error ${index}`,
			});
		expect(log.total).toBe(57);
		expect(log.recent).toHaveLength(APP_RUNTIME_MAX_ERRORS);
		expect(log.recent[0]?.message).toBe("Error 38");
		expect(log.recent.at(-1)?.message).toBe("Error 57");
		expect(EMPTY_APP_RUNTIME_ERROR_LOG).toEqual({ total: 0, recent: [] });
	});
});
