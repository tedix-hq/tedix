import { describe, expect, it, vi } from "vite-plus/test";
import { runInNewContext } from "node:vm";
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
	it("projects exact matches before the Code Mode result budget can replace discovery with a handle", async () => {
		const rows = [
			row,
			...Array.from({ length: 99 }, (_, i) => ({
				...row,
				tool: `other_${i}`,
				description: "Unrelated provider metadata. ".repeat(100),
			})),
		];
		const call = vi.fn(async (_name, args) => {
			const result = await runInNewContext(`(${args.code})()`, {
				discover: { search: async () => rows },
			});
			return envelope(
				JSON.stringify(result).length > 24_000
					? { __tedix_result_handle: true }
					: result,
			);
		});
		expect(
			await resolveSidebarTool(call, "maple", "show_deck", { readOnly: true }),
		).toBe(row.callable);
	});
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

it("keeps discovery query, exact tool and organization filters inside literals", async () => {
	const hostile =
		'"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029';
	const match = { ...row, tool: hostile, organization: hostile };
	const call = vi.fn(async (_name, args) => {
		expect(args.code).not.toContain("</script>");
		expect(args.code).not.toMatch(/[\u2028\u2029]/);
		return envelope(
			await runInNewContext(`(${args.code})()`, {
				discover: {
					search: async (input: unknown) => {
						expect(input).toEqual({
							query: hostile,
							organization: hostile,
							limit: 100,
						});
						return [
							match,
							{ ...match, tool: "other" },
							{ ...match, organization: "other" },
						];
					},
				},
			}),
		);
	});
	expect(await resolveSidebarTool(call, hostile, hostile)).toBe(row.callable);
	expect(call).toHaveBeenCalledTimes(1);
});

it("keeps sidebar action arguments inside a literal", async () => {
	const args = {
		body: '"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029',
	};
	const call = vi.fn(async (_name, input) => {
		expect(input.code).not.toContain("</script>");
		expect(input.code).not.toMatch(/[\u2028\u2029]/);
		return envelope(
			await runInNewContext(`(${input.code})()`, {
				maple_tedix: { show_deck: async (value: unknown) => value },
			}),
		);
	});
	expect(await callSidebarTool(call, row.callable, args)).toEqual(args);
});
