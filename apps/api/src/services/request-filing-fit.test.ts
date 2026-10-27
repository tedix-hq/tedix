import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
const execute = vi.hoisted(() => vi.fn());
vi.mock("./jev-judgment", () => ({ executeJevJudgment: execute }));
import { requestFilingFitModel } from "./request-filing-fit";
const choose = requestFilingFitModel(
	{} as DbClient,
	{} as CloudflareEnv,
	"org-example",
);
const input = {
	context: "Request and live briefs",
	projectIds: ["project-docs"],
	workItemIds: [],
};
const answer = (choice = "project-docs") => ({
	answers: {
		project: {
			type: "choice",
			choice,
			confidence: 0.9,
			probabilities: {
				"project-docs": choice === "project-docs" ? 0.9 : 0.05,
				NONE: choice === "NONE" ? 0.9 : 0.05,
				UNCLEAR: choice === "UNCLEAR" ? 0.9 : 0.05,
			},
		},
		work: {
			type: "choice",
			choice: "NONE",
			confidence: 0.9,
			probabilities: { NONE: 0.9, UNCLEAR: 0.1 },
		},
		actionable: { type: "noul", noul: 0.9 },
	},
});
beforeEach(() => execute.mockReset());
it.each(["project-docs", "NONE", "UNCLEAR"])(
	"chooses %s with organization attribution and configured policy",
	async (choice) => {
		execute.mockResolvedValue(answer(choice));
		expect(await choose(input)).toMatchObject({
			projectId: choice,
			confidence: 0.9,
			actionable: true,
		});
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "@cf/cloudflare/clef-flash",
				context: { organizationId: "org-example" },
				billingSource: "system",
				timeoutMs: 4000,
				questions: expect.objectContaining({
					project: expect.objectContaining({
						type: "choice",
						criteria: {
							"project-docs": "project-docs",
							NONE: "NONE",
							UNCLEAR: "UNCLEAR",
						},
					}),
				}),
			}),
		);
	},
);
it.each(["timeout", "unknown", "missing-option", "nan", "malformed"])(
	"rejects %s without upgrading it to a novel brief",
	async (scenario) => {
		const result = answer();
		if (scenario === "unknown") result.answers.project.choice = "foreign";
		if (scenario === "missing-option")
			delete (result.answers.project.probabilities as Record<string, number>)
				.NONE;
		if (scenario === "nan") result.answers.project.confidence = NaN;
		execute.mockResolvedValue(
			scenario === "timeout"
				? null
				: scenario === "malformed"
					? { answers: {} }
					: result,
		);
		await expect(choose(input)).rejects.toThrow("choice unavailable");
	},
);
it("returns UNCLEAR for tied project probabilities", async () => {
	const result = answer();
	result.answers.project.probabilities = {
		"project-docs": 0.45,
		NONE: 0.1,
		UNCLEAR: 0.45,
	};
	execute.mockResolvedValue(result);
	expect((await choose(input)).projectId).toBe("UNCLEAR");
});

it("offers NONE and UNCLEAR with an empty live portfolio", async () => {
	const result = answer("NONE");
	delete (result.answers.project.probabilities as Record<string, number>)[
		"project-docs"
	];
	result.answers.project.probabilities.UNCLEAR = 0.1;
	execute.mockResolvedValue(result);
	expect((await choose({ ...input, projectIds: [] })).projectId).toBe("NONE");
});
it("rejects an oversized portfolio before dispatch without dropping options", async () => {
	await expect(
		choose({
			...input,
			projectIds: Array.from({ length: 254 }, (_, i) => `p${i}`),
		}),
	).rejects.toThrow("choice options");
	expect(execute).not.toHaveBeenCalled();
});
