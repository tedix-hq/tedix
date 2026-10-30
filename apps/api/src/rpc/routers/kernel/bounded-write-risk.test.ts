import { describe, expect, it } from "vite-plus/test";
import { classifyWriteRisk } from "./write-tool-policy";

const bounded = {
	"com.tedix/policy": {
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
};
describe("bounded Work and Notion write planning", () => {
	it.each(["home__cancel_work_item", "work.cancel_work_items"])(
		"honors reviewed history-preserving %s",
		(name) => {
			expect(
				classifyWriteRisk({
					name,
					_meta: bounded,
					annotations: { destructiveHint: false },
				}),
			).toBe("low");
			expect(classifyWriteRisk({ name })).toBe("high");
		},
	);
	it.each(["cancel_order", "delete_record", "revoke_token"])(
		"retains high risk for %s",
		(name) => {
			expect(classifyWriteRisk({ name, _meta: bounded })).toBe("high");
		},
	);
	it("lets only an operational purpose repair through as a bounded Work update", () => {
		const tool = {
			name: "home__update_work_item",
			_meta: {
				"com.tedix/policy": {
					...bounded["com.tedix/policy"],
					argumentPolicy: "work_item_purpose_repair",
				},
			},
		};
		const id = "11111111-1111-4111-8111-111111111111";
		expect(
			classifyWriteRisk(tool, {
				id,
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2026-11-20T00:00:00.000Z",
			}),
		).toBe("low");
		expect(
			classifyWriteRisk(tool, {
				id,
				purposeExceptionExpiresAt: "2026-11-20T00:00:00.000Z",
			}),
		).toBe("low");
		for (const args of [
			{ id, riskLevel: "low" },
			{ id, workClass: "maintenance", riskLevel: "low" },
			{ id, workClass: "maintenance", executor: "codex" },
			{ id, workClass: "objective" },
			{ id, title: "Renamed" },
			undefined,
		])
			expect(classifyWriteRisk(tool, args)).toBe("high");
	});
	it("keeps legacy argument metadata high risk without a resolved tenant rule", () => {
		const tool = {
			name: "notion_tedix.notion_update_page",
			annotations: { destructiveHint: true },
			_meta: {
				"com.tedix/policy": {
					...bounded["com.tedix/policy"],
					argumentPolicy: "notion_page_update",
				},
				"com.tedix/connectedTool": {
					providerId: "notion",
					toolName: "notion-update-page",
				},
			},
		};
		expect(
			classifyWriteRisk(tool, {
				page_id: "example",
				command: "update_properties",
				properties: { Status: "Done" },
			}),
		).toBe("high");
		expect(
			classifyWriteRisk(tool, {
				page_id: "example",
				command: "replace_content",
				content: "Overwrite",
			}),
		).toBe("high");
		expect(classifyWriteRisk(tool)).toBe("high");
		expect(
			classifyWriteRisk(
				{ ...tool, _meta: { ...tool._meta, "com.tedix/connectedTool": null } },
				{
					page_id: "example",
					command: "update_properties",
					properties: {},
				},
			),
		).toBe("high");
	});
	it("permits reviewed page creation but keeps unclassified creation gated", () => {
		expect(
			classifyWriteRisk({
				name: "notion_create_pages",
				_meta: bounded,
				annotations: { destructiveHint: false },
			}),
		).toBe("low");
		expect(classifyWriteRisk({ name: "notion_create_pages" })).toBe("high");
	});
});
