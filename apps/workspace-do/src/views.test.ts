import { describe, expect, test } from "bun:test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import { buildWorkspaceBindings } from "./bindings";
import type { WorkspaceDataPort } from "./data-port";
import { buildView, MAX_VIEW_BYTES, type ShownView } from "./views";

describe("workspace views", () => {
	test("a record list becomes a table the widget frame can render", () => {
		const view = buildView(
			{
				title: "Open Work",
				data: [
					{ title: "Fix login", disposition: "accepted", estimate: 3 },
					{ title: "Ship docs", disposition: "in_progress", estimate: 1 },
				],
			},
			"v1",
		);
		expect(view.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix-unified/r/open-work.html",
		);
		const spec = view.toolResult.layoutSpec as {
			root: string;
			elements: Record<
				string,
				{ type: string; props: Record<string, unknown> }
			>;
		};
		expect(spec.elements[spec.root]?.type).toBe("Stack");
		const table = spec.elements.table!;
		expect(table.type).toBe("DataTable");
		expect(table.props.data).toEqual({ $state: "/rows" });
		expect(
			(table.props.columns as Array<{ field: string; format: string }>).map(
				(column) => [column.field, column.format],
			),
		).toEqual([
			["title", "text"],
			["disposition", "badge"],
			["estimate", "number"],
		]);
		expect(view.toolResult.rows).toHaveLength(2);
	});

	test("plain fields become facts; a custom layout passes through", () => {
		const facts = buildView(
			{ title: "Totals", data: { open: 4, done: 9 } },
			"v",
		);
		const spec = facts.toolResult.layoutSpec as {
			elements: Record<string, { type: string }>;
		};
		expect(spec.elements.facts?.type).toBe("KeyValuePanel");
		const layoutSpec = {
			root: "r",
			elements: { r: { type: "Text", props: { text: "Hi" }, children: [] } },
		};
		expect(
			buildView({ title: "Custom", data: {}, layoutSpec }, "v").toolResult
				.layoutSpec,
		).toEqual(layoutSpec);
	});

	test("bad input is refused with a reason the model can act on", () => {
		expect(() => buildView({ data: {} }, "v")).toThrow("title");
		expect(() => buildView({ title: "x", data: "text" }, "v")).toThrow("data");
		expect(() =>
			buildView({ title: "x", data: {}, layoutSpec: { root: "a" } }, "v"),
		).toThrow("layoutSpec");
		expect(() =>
			buildView(
				{ title: "x", data: { blob: "a".repeat(MAX_VIEW_BYTES) } },
				"v",
			),
		).toThrow("bytes");
	});

	test("views.show hands the view to the turn and records a read", async () => {
		const shown: ShownView[] = [];
		const adapters = createInMemoryAdapters();
		const env = buildWorkspaceBindings({
			data: {} as WorkspaceDataPort,
			...adapters,
			actor: { id: "agent", kind: "tedi", organizationId: "o" },
			source: { surface: "workspace_object", traceId: "t" },
			showView: (view) => shown.push(view),
		});
		const views = env.views as { show(input: unknown): Promise<unknown> };
		const result = (await views.show({ title: "T", data: { a: 1 } })) as {
			viewId: string;
			shown: boolean;
		};
		expect(result.shown).toBe(true);
		expect(shown.map((view) => view.viewId)).toEqual([result.viewId]);
	});
});
