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
	it("classifies the exact Notion command after argument validation", () => {
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
		).toBe("low");
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
