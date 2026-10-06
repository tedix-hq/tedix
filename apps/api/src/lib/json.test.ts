import { describe, expect, test } from "vite-plus/test";

import { omitUndefined } from "./json";

describe("omitUndefined", () => {
	test("removes only undefined fields while preserving JSON values", () => {
		const input = {
			keptNull: null,
			keptFalse: false,
			keptZero: 0,
			keptEmptyString: "",
			keptArray: ["value"],
			keptObject: { nested: true },
			removed: undefined,
		};

		expect(omitUndefined(input)).toEqual({
			keptNull: null,
			keptFalse: false,
			keptZero: 0,
			keptEmptyString: "",
			keptArray: ["value"],
			keptObject: { nested: true },
		});
	});
});
