import { describe, expect, test } from "vite-plus/test";
import { wranglerRuntimeExecutable } from "./wrangler-command";

describe("wranglerRuntimeExecutable", () => {
	test("uses the current runtime by default", () => {
		expect(wranglerRuntimeExecutable({}, "/bin/bun")).toBe("/bin/bun");
	});

	test("preserves Bun when the migration gate itself runs in Node", () => {
		expect(
			wranglerRuntimeExecutable(
				{ TEDIX_BUN_EXEC_PATH: "/opt/bun" },
				"/opt/node",
			),
		).toBe("/opt/bun");
	});

	test("uses Bun from PATH when a standalone drift check runs in Node", () => {
		expect(wranglerRuntimeExecutable({}, "/opt/node")).toBe("bun");
	});
});
