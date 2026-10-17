import { describe, expect, it, mock } from "bun:test";
import {
	pushObservation,
	notifyObserver,
} from "./notify-repository-observer.mjs";
describe("repository event notifier", () => {
	it("uses the full push range and carries a Work trailer as data", () => {
		const git = mock((...args: string[]) =>
			args[0] === "show"
				? "A harmless doc edit\nWork-Item: 11111111-1111-4111-8111-111111111111"
				: args.includes("--stat")
					? "2 files changed"
					: "docs/a.md\ndocs/b.md",
		);
		const result = pushObservation(
			{
				projectId: "project",
				repository: "example/product",
				branch: "main",
				sha: "a".repeat(40),
				before: "b".repeat(40),
				runUrl: "https://github.com/example/product/actions/runs/1",
			},
			git,
		);
		expect(result.paths).toEqual(["docs/a.md", "docs/b.md"]);
		expect(result.workItemId).toBe("11111111-1111-4111-8111-111111111111");
		expect(git).toHaveBeenCalledWith(
			"diff",
			"--name-only",
			"b".repeat(40),
			"a".repeat(40),
		);
	});
	it("fails on rejected delivery and never treats it as a receipt", async () => {
		const fetcher = mock()
			.mockResolvedValueOnce(Response.json({ value: "ephemeral-token" }))
			.mockResolvedValueOnce(new Response("", { status: 503 }));
		await expect(
			notifyObserver(
				"https://api.example/observer",
				{},
				{
					env: {
						ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/request",
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
					},
					fetcher,
				},
			),
		).rejects.toThrow("503");
		expect(fetcher.mock.calls[1]?.[1]?.redirect).toBe("error");
	});
});
