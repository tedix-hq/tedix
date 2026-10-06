import { describe, expect, it } from "vite-plus/test";
import {
	safeErrorClassification,
	safeErrorMetadata,
	safeExceptionTopology,
} from "./safe-log-metadata";

describe("safeExceptionTopology", () => {
	it("retains causes but excludes credential and arbitrary exception text", () => {
		const error = new Error("sk_live_secret in request", {
			cause: new TypeError("DSR=refresh-secret"),
		});
		error.name = "sk_live_custom_name";
		Object.assign(error, { code: "sk_live_custom_code" });

		const topology = safeExceptionTopology(error);
		expect(topology).toEqual({
			type: "UnknownThrown",
			cause: { type: "TypeError" },
		});
		expect(JSON.stringify(topology)).not.toMatch(
			/sk_live|DSR=|message|stack|code/,
		);
	});
});

describe("safeErrorMetadata", () => {
	it("hashes the message and classifies a D1 cause with fixed phrases only", async () => {
		const cause = new Error(
			"D1_ERROR: Network connection lost. Attempted query: select secret_col from users where token = 'sk_live_abc'",
		);
		const error = new Error(
			"Failed query: select secret_col from users where token = ?\nparams: sk_live_abc",
			{ cause },
		);
		error.name = "DrizzleQueryError";

		const metadata = await safeErrorMetadata(error);

		expect(metadata.name).toBe("DrizzleQueryError");
		// The raw texts must never appear anywhere in the metadata.
		expect(JSON.stringify(metadata)).not.toContain("sk_live_abc");
		expect(JSON.stringify(metadata)).not.toContain("secret_col");
		expect(metadata.message).toMatchObject({ chars: expect.any(Number) });
		expect(metadata.cause).toMatchObject({
			name: "Error",
			valueRedacted: true,
			messageClass: ["D1_ERROR", "Network connection lost"],
		});
	});

	it("classifies nested D1 causes without exposing queries and bounds cyclic chains", async () => {
		const transport = new Error(
			"D1 DB storage operation exceeded timeout [code: 7500] token=secret-token",
		);
		const wrapped = new Error("D1_ERROR: query secret-query failed", {
			cause: transport,
		});
		const outer = new Error("query wrapper", { cause: wrapped });
		transport.cause = outer;
		const metadata = await safeErrorMetadata(outer);
		expect(metadata.causeChain).toEqual([
			{
				name: "Error",
				messageClass: ["D1_ERROR"],
				numericCode: undefined,
				valueRedacted: true,
			},
			{
				name: "Error",
				messageClass: ["exceeded timeout"],
				numericCode: "7500",
				valueRedacted: true,
			},
		]);
		expect(JSON.stringify(metadata)).not.toContain("secret-token");
		expect(JSON.stringify(metadata)).not.toContain("secret-query");
	});

	it("omits messageClass when no fixed phrase matches", async () => {
		const metadata = await safeErrorMetadata(new Error("something unrelated"));
		expect(metadata.messageClass).toBeUndefined();
		expect(metadata.cause).toBeUndefined();
	});
});

describe("safeErrorClassification", () => {
	it.each([
		"malformed JSON",
		"too many SQL variables",
		"CHECK constraint failed",
		"FOREIGN KEY constraint failed",
		"UNIQUE constraint failed",
		"NOT NULL constraint failed",
	])(
		"retains fixed %s category and excludes dynamic error contents",
		(category) => {
			const error = new Error("private query params secret-token", {
				cause: new Error(
					`D1_ERROR: ${category}: private-column secret-value [code: 7500]`,
				),
			});
			error.name = "private-name";
			const result = safeErrorClassification(error);
			expect(result.causeChain?.[0].messageClass).toContain(category);
			expect(result.causeChain?.[0].numericCode).toBe("7500");
			expect(JSON.stringify(result)).not.toMatch(
				/private|secret|sha256|query|params/,
			);
		},
	);
	it("bounds circular chains and redacts non-Error values", () => {
		const error = new Error("D1_ERROR");
		error.cause = error;
		expect(safeErrorClassification(error)).toEqual({
			messageClass: ["D1_ERROR"],
			causeChain: undefined,
		});
		expect(
			safeErrorClassification({ message: "malformed JSON secret" }),
		).toEqual({});
	});
});
