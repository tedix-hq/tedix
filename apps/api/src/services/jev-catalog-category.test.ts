import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { categoryEnum } from "@tedix/db/schema/catalog";
const execute = vi.hoisted(() => vi.fn());
vi.mock("./jev-judgment", () => ({ executeJevJudgment: execute }));
import {
	catalogCategoryRequest,
	classifyCatalogCategory,
	selectedCatalogCategory,
} from "./jev-catalog-category";

const options = {
	db: {},
	env: {},
	context: { organizationId: "platform-org", runId: "run-1" },
} as Parameters<typeof classifyCatalogCategory>[0];
const result = (choice: string) => ({
	model: "jev-1.13.0",
	usage: { input_tokens: 120, output_tokens: 20 },
	answers: {
		category: {
			type: "choice" as const,
			choice,
			probabilities: { [choice]: 1 },
			confidence: 1,
		},
	},
});
describe("catalog Jev classification", () => {
	beforeEach(() => {
		execute.mockReset();
	});
	it("uses the canonical categories and an explicit no-match option", () => {
		const request = catalogCategoryRequest({
			name: "Ledger",
			description: "Invoice reconciliation and cash-flow reporting",
		})!;
		expect(Object.keys(request.questions.category.criteria)).toEqual([
			...categoryEnum,
			"NONE",
		]);
		expect(request.state.description).toContain("reconciliation");
	});
	it("does not spend on a name without functional evidence", async () => {
		expect(
			await classifyCatalogCategory(options, { name: "Unknown" }),
		).toBeNull();
		expect(execute).not.toHaveBeenCalled();
	});
	it("dispatches through governed system attribution without an opt-in flag", async () => {
		execute.mockResolvedValue(result("FINANCE"));
		expect(
			await classifyCatalogCategory(options, {
				name: "Ledger",
				description: "Invoice reconciliation",
			}),
		).toBe("FINANCE");
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				context: options.context,
				billingSource: "system",
				source: "catalog:category",
				sessionType: "unattributed",
			}),
		);
	});
	it("leaves classification unset on NONE, unavailable, or unknown category", () => {
		expect(selectedCatalogCategory(result("NONE"))).toBeNull();
		expect(selectedCatalogCategory(null)).toBeNull();
		expect(selectedCatalogCategory(result("INVENTED"))).toBeNull();
	});
	it("preserves usage persistence failures instead of manufacturing a category", async () => {
		execute.mockRejectedValue(new Error("receipt unavailable"));
		const error = await classifyCatalogCategory(options, {
			name: "Ledger",
			description: "Finance",
		}).then(
			() => null,
			(error) => error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("receipt unavailable");
	});
});
