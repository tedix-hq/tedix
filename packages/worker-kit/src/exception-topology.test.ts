import { describe, expect, it } from "vite-plus/test";
import { exceptionTopology } from "./exception-topology";

describe("exceptionTopology", () => {
	it("retains nested causes without messages or stacks", () => {
		expect(
			exceptionTopology(
				new Error("secret", { cause: new TypeError("credential") }),
			),
		).toEqual({
			type: "Error",
			cause: { type: "TypeError" },
		});
	});

	it("retains bounded AggregateError children and ignores malformed errors", () => {
		expect(
			exceptionTopology(
				new AggregateError(
					[new RangeError("secret"), null, "secret", {}, new Error("omitted")],
					"secret",
				),
			),
		).toEqual({
			type: "AggregateError",
			errors: [
				{ type: "RangeError" },
				{ type: "NullThrown" },
				{ type: "UnknownThrown" },
				{ type: "ObjectThrown" },
			],
			truncated: true,
		});
		expect(exceptionTopology({ name: "Error", errors: "secret" })).toEqual({
			type: "Error",
		});
		expect(exceptionTopology({ name: "Error", errors: [] })).toEqual({
			type: "Error",
			errors: [],
		});
	});

	it("bounds cause depth and handles cycles", () => {
		const chain = {
			name: "Error",
			cause: {
				name: "Error",
				cause: {
					name: "Error",
					cause: { name: "Error", cause: new Error("secret") },
				},
			},
		};
		expect(exceptionTopology(chain)).toEqual({
			type: "Error",
			cause: {
				type: "Error",
				cause: {
					type: "Error",
					cause: {
						type: "Error",
						cause: { type: "TruncatedCause", truncated: true },
					},
				},
			},
		});
		const cyclic: { cause?: unknown } = {};
		cyclic.cause = cyclic;
		expect(exceptionTopology(cyclic)).toEqual({
			type: "ObjectThrown",
			cause: { type: "CircularCause", truncated: true },
		});
	});

	it("does not retain custom names, messages, stacks or arbitrary fields", () => {
		expect(
			exceptionTopology({
				name: "secret",
				message: "secret",
				stack: "secret",
				token: "secret",
				cause: { name: "TypeError", message: "secret", stack: "secret" },
			}),
		).toEqual({ type: "UnknownThrown", cause: { type: "TypeError" } });
	});
});
