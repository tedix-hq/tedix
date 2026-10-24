import { describe, expect, it, vi } from "vite-plus/test";
import { callSidebarTool, resolveSidebarTool } from "./sidebar-tools";

const envelope = (result: unknown) => ({ structuredContent: { result } });
const row = {
	tool: "show_deck",
	organization: "maple",
	authorized: true,
	annotations: { readOnlyHint: true },
	callable: "maple_tedix.show_deck",
};

describe("sidebar tool bridge", () => {
	it("never runs a write tool merely by opening a tab", async () => {
		const call = vi.fn().mockResolvedValue(
			envelope({
				results: [{ ...row, annotations: { readOnlyHint: false } }],
			}),
		);
		await expect(
			resolveSidebarTool(call, "maple", "show_deck", { readOnly: true }),
		).rejects.toThrow("unavailable");
	});
	it("resolves an exact authorized tool in the selected organization", async () => {
		const call = vi
			.fn()
			.mockResolvedValue(
				envelope({ results: [row, { ...row, organization: "other" }] }),
			);
		expect(await resolveSidebarTool(call, "maple", "show_deck")).toBe(
			row.callable,
		);
		expect(call.mock.calls[0]![1].code).toContain('"organization":"maple"');
	});
	it.each([
		[{ ...row, authorized: false }],
		[{ ...row, organization: "other" }],
		[row, row],
		[{ ...row, callable: "bad();steal()" }],
	])(
		"refuses denied, cross-organization, ambiguous or invalid callables",
		async (...args) => {
			const call = vi.fn().mockResolvedValue(envelope({ results: args }));
			await expect(
				resolveSidebarTool(call, "maple", "show_deck"),
			).rejects.toThrow("unavailable");
		},
	);
	it("uses complete widget data and safely encodes action text", async () => {
		const data = { cards: [{ id: "one" }], complete: true };
		const call = vi.fn().mockResolvedValue({
			...envelope({ markdown: "Summary" }),
			_meta: { "tedix/widgetData": data },
		});
		expect(
			await callSidebarTool(call, row.callable, { body: '";bad()' }),
		).toEqual(data);
		expect(call.mock.calls[0]![1].code).toContain(
			JSON.stringify({ body: '";bad()' }),
		);
	});
	it.each([
		{ isError: true },
		{ structuredContent: { partial: true, result: { cards: [] } } },
		envelope({ ok: false }),
	])("does not turn a failed read into an empty success", async (result) => {
		await expect(
			callSidebarTool(vi.fn().mockResolvedValue(result), row.callable, {}),
		).rejects.toThrow();
	});
});
