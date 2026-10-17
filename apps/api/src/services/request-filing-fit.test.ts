import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
const execute = vi.hoisted(() => vi.fn());
vi.mock("./jev-judgment", () => ({ executeJevJudgment: execute }));
import { requestFilingFitModel } from "./request-filing-fit";
beforeEach(() => execute.mockReset());
it("scores semantic fit through governed Clef-flash with organization attribution", async () => {
	execute.mockResolvedValue({
		answers: { fits: { type: "noul", noul: 0.82 } },
	});
	const score = requestFilingFitModel(
		{} as DbClient,
		{} as CloudflareEnv,
		"org-example",
	);
	expect(
		await score({
			request: "Fix installation",
			project: { name: "Documentation" },
			corrections: [],
		}),
	).toBe(0.82);
	expect(execute).toHaveBeenCalledWith(
		expect.objectContaining({
			model: "@cf/cloudflare/clef-flash",
			context: { organizationId: "org-example" },
			billingSource: "system",
		}),
	);
});
it("does not upgrade unavailable scoring into confident filing", async () => {
	execute.mockResolvedValue(null);
	const score = requestFilingFitModel(
		{} as DbClient,
		{} as CloudflareEnv,
		"org-example",
	);
	await expect(
		score({ request: "Fix installation", project: {}, corrections: [] }),
	).rejects.toThrow("fit score unavailable");
});
