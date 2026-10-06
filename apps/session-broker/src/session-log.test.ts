import { describe, expect, it } from "vite-plus/test";
import { sessionExceptionTopology } from "./session-log";

describe("sessionExceptionTopology", () => {
	it("retains bounded causes without JWTs, messages, stacks or arbitrary codes", () => {
		const error = new Error("DS=secret-session-token", {
			cause: new TypeError("DSR=secret-refresh-token"),
		});
		error.name = "DS=secret-custom-name";
		Object.assign(error, { code: "DSR=secret-provider-code" });

		const exception = sessionExceptionTopology(error);
		expect(exception).toEqual({
			type: "UnknownThrown",
			cause: { type: "TypeError" },
		});
		expect(JSON.stringify(exception)).not.toMatch(
			/DS=|DSR=|message|stack|code/,
		);
	});
});
