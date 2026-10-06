import { describe, expect, it } from "vite-plus/test";
import { buildQueryString } from "./query-params";

describe("buildQueryString", () => {
	it("honors imported Graph non-exploded query arrays without changing defaults", () => {
		const search = new URLSearchParams(
			buildQueryString(
				{
					$select: ["id", "name"],
					$expand: ["events($select=id,subject)", "owner"],
					$orderby: ["start/dateTime desc", "subject"],
					ids: [1, 2],
					empty: [],
				},
				{
					$select: "comma",
					$expand: "comma",
					$orderby: "comma",
					empty: "comma",
				},
			),
		);
		expect(search.getAll("$select")).toEqual(["id,name"]);
		expect(search.getAll("$expand")).toEqual([
			"events($select=id,subject),owner",
		]);
		expect(search.getAll("$orderby")).toEqual(["start/dateTime desc,subject"]);
		expect(search.getAll("ids")).toEqual(["1", "2"]);
		expect(search.has("empty")).toBe(false);
	});
	it.each([
		["space", " "],
		["pipe", "|"],
	] as const)("supports %s-delimited OpenAPI arrays", (format, delimiter) => {
		const search = new URLSearchParams(
			buildQueryString({ ids: [1, 2] }, { ids: format }),
		);
		expect(search.getAll("ids")).toEqual([`1${delimiter}2`]);
	});
	it("serializes nested OpenAPI query objects with bracket keys", () => {
		const search = new URLSearchParams(
			buildQueryString({
				view: "all",
				sevQuery: {
					objectName: "SevQuery",
					modelName: "Invoice",
					filter: {
						invoiceType: ["RE", "SR"],
						contact: { id: 123, objectName: "Contact" },
					},
				},
			}),
		);

		expect(search.get("view")).toBe("all");
		expect(search.get("sevQuery[objectName]")).toBe("SevQuery");
		expect(search.get("sevQuery[modelName]")).toBe("Invoice");
		expect(search.get("sevQuery[filter][invoiceType][0]")).toBe("RE");
		expect(search.get("sevQuery[filter][invoiceType][1]")).toBe("SR");
		expect(search.get("sevQuery[filter][contact][id]")).toBe("123");
		expect(search.get("sevQuery[filter][contact][objectName]")).toBe("Contact");
	});

	it("keeps top-level arrays as repeated query parameters", () => {
		const search = new URLSearchParams(
			buildQueryString({ ids: [1, 2], status: "open" }),
		);

		expect(search.getAll("ids")).toEqual(["1", "2"]);
		expect(search.get("status")).toBe("open");
	});
});
