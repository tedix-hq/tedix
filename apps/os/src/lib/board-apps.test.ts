import { expect, it } from "vite-plus/test";
import { boardAppLink } from "./board-apps";

it("only links explicitly configured active apps and uses the stored name", () => {
	const gadget = {
		id: "11111111-1111-4111-8111-111111111111",
		workspaceId: "22222222-2222-4222-8222-222222222222",
		name: "Supplier replies",
		status: "active" as const,
	};
	const manifest = {
		entry: "tedix:app/outbound-review",
		capabilities: [],
		config: { version: 1 },
	};
	expect(boardAppLink(gadget, manifest)).toBeNull();
	expect(boardAppLink(gadget, null)).toBeNull();
	expect(
		boardAppLink(gadget, { ...manifest, navigation: { board: false } }),
	).toBeNull();
	expect(
		boardAppLink(
			{ ...gadget, status: "archived" },
			{ ...manifest, navigation: { board: true } },
		),
	).toBeNull();
	expect(
		boardAppLink(gadget, { ...manifest, navigation: { board: true } }),
	).toEqual({
		id: gadget.id,
		name: "Supplier replies",
		href: `/workspace/${gadget.workspaceId}?workpiece=gadget:${gadget.id}&pane=workpiece`,
	});
});
