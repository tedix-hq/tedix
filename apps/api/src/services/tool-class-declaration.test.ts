import { declaredToolClass } from "@tedix/api-contract/utils/tool-declared-class";
import { describe, expect, it } from "vite-plus/test";
import { resolveToolClassForSave } from "./tool-class-declaration";

const tier = {
	"com.tedix/policy": {
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
};
const save = (
	overrides: Partial<Parameters<typeof resolveToolClassForSave>[0]>,
) =>
	resolveToolClassForSave({
		toolId: "tidy_notes",
		writeCapability: "write",
		meta: null,
		classStated: true,
		tierStated: false,
		...overrides,
	});

describe("tool class on save", () => {
	it("refuses a tool with no write class", () => {
		const result = save({ writeCapability: null, classStated: false });
		expect(result).toMatchObject({ ok: false });
		expect(result.ok ? "" : result.reason).toContain("no write class");
	});

	it("refuses an older row until its write class is supplied", () => {
		expect(save({ writeCapability: null, classStated: false })).toMatchObject({
			ok: false,
		});
	});

	it("refuses a write without an explicit risk tier", () => {
		const result = save({});
		expect(result.ok ? "" : result.reason).toContain("has no risk tier");
	});

	it("marks the row declared when class and tier are both stated", () => {
		const result = save({ meta: tier, tierStated: true });
		if (!result.ok) throw new Error(result.reason);
		expect(
			declaredToolClass({ writeCapability: "write", meta: result.meta }),
		).toEqual({ writeCapability: "write", ...tier["com.tedix/policy"] });
	});

	it("does not mark a class derived from annotations as declared", () => {
		const result = save({ meta: tier, classStated: false, tierStated: true });
		if (!result.ok) throw new Error(result.reason);
		expect(result.meta).toEqual(tier);
	});

	it("refuses a declared marker without both statements", () => {
		const result = save({
			meta: { "com.tedix/policy": { declared: true } },
		});
		expect(result.ok ? "" : result.reason).toContain("marked declared");
	});

	it("refuses a destructive tool stated as a bounded write", () => {
		const result = save({
			writeCapability: "destructive",
			meta: tier,
			tierStated: true,
		});
		expect(result.ok ? "" : result.reason).toContain("declared destructive");
	});
});
