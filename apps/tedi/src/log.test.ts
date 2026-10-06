import { describe, expect, it } from "vite-plus/test";
import { contentFreeTediException } from "./log";

describe("Tedi exception diagnostics", () => {
	it("keeps nested failure types without message, stack, or thrown content", () => {
		const failure = new AggregateError(
			[new Error("user process output bearer-secret")],
			"credential error with caller input",
			{ cause: new Error("nested secret") },
		);
		const diagnostic = contentFreeTediException(failure);
		expect(diagnostic).toMatchObject({
			name: "AggregateError",
			message: "Content omitted",
			cause: { name: "Error", message: "Content omitted" },
			errors: [{ name: "Error", message: "Content omitted" }],
		});
		const serialized = JSON.stringify(diagnostic);
		expect(serialized).not.toContain("bearer-secret");
		expect(serialized).not.toContain("caller input");
		expect(serialized).not.toContain("nested secret");
		expect(serialized).not.toContain("stack");
	});

	it("does not carry a caller-controlled exception name", () => {
		const error = new Error("body-secret");
		error.name = "BearerSecretToken";
		expect(contentFreeTediException(error)).toEqual({
			name: "Error",
			message: "Content omitted",
		});
	});
});
