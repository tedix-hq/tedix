import { describe, expect, test } from "vite-plus/test";
import {
	appEditRequestFrom,
	publishPendingAppEdits,
} from "@/lib/app-edit-approval";

describe("appEditRequestFrom", () => {
	test("reads an app revise request", () => {
		expect(
			appEditRequestFrom({
				appId: "a1",
				files: { "client.js": "x" },
				expectedRevision: 3,
			}),
		).toEqual({
			appId: "a1",
			files: { "client.js": "x" },
			expectedRevision: 3,
		});
	});
	test("ignores other approvals", () => {
		expect(appEditRequestFrom({ outputId: "o", content: {} })).toBeNull();
		expect(
			appEditRequestFrom({ appId: "a", files: { a: 1 }, expectedRevision: 1 }),
		).toBeNull();
		expect(appEditRequestFrom(null)).toBeNull();
	});
	test("publishing an empty list is allowed", () => {
		expect(() => publishPendingAppEdits([])).not.toThrow();
	});
});
