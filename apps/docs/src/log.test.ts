import { expect, it, vi } from "vite-plus/test";
import { logDocsFailure } from "./log";

it("logs bounded exception topology without tenant content", () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const root = new Error("private source /tenant/acme/docs/token.md");
		root.name = "AcmeBuildError";
		const failure = new AggregateError(
			[root, new TypeError("credential sk_private")],
			"customer text",
			{ cause: new Error("repository https://private.example") },
		);
		logDocsFailure("docs.build_failed", failure);
		expect(log).toHaveBeenCalledExactlyOnceWith({
			component: "docs",
			event: "docs.build_failed",
			exception: {
				name: "AggregateError",
				cause: { name: "Error" },
				errors: [{ name: "Error" }, { name: "TypeError" }],
			},
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/private|tenant|credential|source|token|stack|AcmeBuildError/,
		);
	} finally {
		log.mockRestore();
	}
});
