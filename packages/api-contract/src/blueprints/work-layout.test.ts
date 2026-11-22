import { describe, expect, it } from "vite-plus/test";
import { readWorkLayout } from "./work-layout";

describe("workspace decision layouts", () => {
	it("can group and rearrange the signed-in viewer's card sections", () => {
		const layout = {
			desk: ["queue"],
			card: [
				"heading",
				{
					display: "columns",
					title: "Review",
					sections: ["actions", "request"],
				},
			],
		};
		expect(readWorkLayout("deck", JSON.stringify(layout))).toEqual(layout);
	});
	it("rejects a layout that duplicates actions or hides the request", () => {
		expect(() =>
			readWorkLayout(
				"deck",
				JSON.stringify({
					desk: ["queue"],
					card: ["heading", "actions", "actions"],
				}),
			),
		).toThrow();
	});
});
