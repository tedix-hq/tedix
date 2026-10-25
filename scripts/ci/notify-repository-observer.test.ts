import { describe, expect, it, mock, spyOn } from "bun:test";
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
					: args[0] === "rev-list"
						? `${"a".repeat(40)}\n${"c".repeat(40)}`
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
		expect(result.commitShas).toEqual(["a".repeat(40), "c".repeat(40)]);
		expect(git).toHaveBeenCalledWith(
			"rev-list",
			"--max-count=100",
			`${"b".repeat(40)}..${"a".repeat(40)}`,
		);
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
	for (const traceId of [
		"11111111-1111-4111-8111-111111111111",
		"ABCDEF0123456789ABCDEF0123456789",
	]) {
		it(`reports safe response correlation for ${traceId.length}-character trace IDs`, async () => {
			const payload = { summary: "private-payload" };
			const response = new Response("private-error-body", {
				status: 500,
				headers: {
					"X-Tedix-Trace-Id": traceId,
					"CF-Ray": "abcdef0123456789-FRA",
				},
			});
			const fetcher = mock()
				.mockResolvedValueOnce(Response.json({ value: "ephemeral-token" }))
				.mockResolvedValueOnce(response);
			const error = await notifyObserver(
				"https://api.example/observer",
				payload,
				{
					env: {
						ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/request",
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
					},
					fetcher,
				},
			).catch((error: unknown) => error);
			if (!(error instanceof Error))
				throw new Error("Expected observer rejection");
			expect(error.message).toBe(
				`Observer rejected event (500) [traceId=${traceId}, cfRay=abcdef0123456789-FRA]`,
			);
			for (const secret of [
				"private-error-body",
				"private-payload",
				"ephemeral-token",
				"request-token",
			])
				expect(error.stack).not.toContain(secret);
			expect(response.bodyUsed).toBe(false);
			expect(fetcher).toHaveBeenCalledTimes(2);
			expect(fetcher.mock.calls[0]?.[0]?.searchParams.get("audience")).toBe(
				"tedix:repository-observer",
			);
			expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
				Authorization: "Bearer ephemeral-token",
				"Content-Type": "application/json",
			});
			expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(payload));
		});
	}
	it("reports only validated headers and never reads an error body", async () => {
		for (const [traceId, cfRay, suffix] of [
			["private-token", "private-token", ""],
			[
				"a".repeat(32) + "\nprivate-token",
				"abcdef0123456789-FRA\r\nprivate-token",
				"",
			],
			["a".repeat(33), "abcdef0123456789-PRIVATE", ""],
			["a".repeat(32), "private-token", ` [traceId=${"a".repeat(32)}]`],
			["private-token", "abcdef0123456789", " [cfRay=abcdef0123456789]"],
		] as const) {
			const response = new Response("private-error-body", { status: 500 });
			const getter = spyOn(response.headers, "get").mockImplementation(
				(name) =>
					name === "X-Tedix-Trace-Id"
						? traceId
						: name === "CF-Ray"
							? cfRay
							: null,
			);
			try {
				const fetcher = mock()
					.mockResolvedValueOnce(Response.json({ value: "ephemeral-token" }))
					.mockResolvedValueOnce(response);
				const error = await notifyObserver(
					"https://api.example/observer",
					{ summary: "private-payload" },
					{
						env: {
							ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/request",
							ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
						},
						fetcher,
					},
				).catch((error: unknown) => error);
				if (!(error instanceof Error))
					throw new Error("Expected observer rejection");
				expect(error.message).toBe(`Observer rejected event (500)${suffix}`);
				expect(error.stack).not.toContain("private-");
				expect(error.stack).not.toContain("ephemeral-token");
				expect(response.bodyUsed).toBe(false);
				expect(fetcher).toHaveBeenCalledTimes(2);
			} finally {
				getter.mockRestore();
			}
		}
	});
	it("keeps successful JSON enqueue acknowledgments unchanged", async () => {
		const receipt = {
			observationId: "11111111-1111-4111-8111-111111111111",
			status: "queued",
		};
		const fetcher = mock()
			.mockResolvedValueOnce(Response.json({ value: "ephemeral-token" }))
			.mockResolvedValueOnce(Response.json(receipt, { status: 202 }));
		expect(
			await notifyObserver(
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
		).toEqual(receipt);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
