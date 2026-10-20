import { createRouterClient } from "@orpc/server";
import { HTTPException } from "hono/http-exception";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const submit = vi.hoisted(() => vi.fn());
vi.mock("../../../services/agent-review", () => ({ fileAgentReview: submit }));
import { fileAgentReviewProcedure } from "./agent-review";

const input = {
	reportMarkdown: "A fictional project's static review with no live calls. "
		.repeat(5)
		.trim(),
	feedback: {
		version: 1 as const,
		reviewedSha: "a".repeat(40),
		projectContext: "Fictional document service",
		fitScore: 2,
		blockers: [],
		suggestions: [],
		bugs: [],
	},
};
const quota = vi.fn();
function client(scopes = ["mcp:work.write"]) {
	return createRouterClient(
		{ file: fileAgentReviewProcedure },
		{
			context: {
				db: {},
				organizationId: "fictional-caller",
				env: { AGENT_REVIEW_RATE_LIMITER: { limit: quota } },
				headers: new Headers(),
				authType: "apikey",
				apiKey: { id: "fictional-key", scopes },
			} as unknown as BaseContext,
		},
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	quota.mockResolvedValue({ success: true });
	submit.mockResolvedValue({
		receiptUrl:
			"https://api.example.test/public/agent-review/fictional-receipt",
		status: "received",
		reportMarkdown: "must never escape",
	});
});

it("calls the same intake service without an external fetch and returns only receipt fields", async () => {
	const receipt = await client().file(input);
	expect(submit).toHaveBeenCalledWith(
		{},
		expect.any(Object),
		input,
		"fictional-caller",
	);
	expect(quota).not.toHaveBeenCalled();
	expect(receipt).toEqual({
		receiptUrl:
			"https://api.example.test/public/agent-review/fictional-receipt",
		status: "received",
	});
});
it("requires the Work write scope before calling intake", async () => {
	await expect(client(["mcp:work.read"]).file(input)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(submit).not.toHaveBeenCalled();
});
it("preserves the intake quota response", async () => {
	submit.mockRejectedValue(
		new HTTPException(429, { message: "Daily review intake is full" }),
	);
	await expect(client().file(input)).rejects.toMatchObject({
		code: "TOO_MANY_REQUESTS",
	});
	expect(submit).toHaveBeenCalledOnce();
});
it("fails closed on quota failures", async () => {
	submit.mockRejectedValue(new Error("limiter offline"));
	await expect(client().file(input)).rejects.toMatchObject({
		code: "SERVICE_UNAVAILABLE",
	});
	expect(submit).toHaveBeenCalledOnce();
});
it("preserves validation failure without exposing arbitrary storage errors", async () => {
	submit.mockRejectedValueOnce(
		new HTTPException(413, { message: "Review exceeds 32 KiB" }),
	);
	await expect(client().file(input)).rejects.toMatchObject({
		code: "BAD_REQUEST",
		message: "Review exceeds 32 KiB",
	});
	submit.mockRejectedValueOnce(
		new Error("storage failed with private report text"),
	);
	await expect(client().file(input)).rejects.toMatchObject({
		code: "SERVICE_UNAVAILABLE",
		message: "Review intake unavailable; retry the identical payload",
	});
});
