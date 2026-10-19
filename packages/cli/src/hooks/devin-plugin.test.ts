import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipDevinPluginHook } from "./devin-plugin";
import { runHooksCommand } from "./command";

test("plugin hooks defer only to matching managed definitions and governed lanes", () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-devin-plugin-"));
	const env = { XDG_CONFIG_HOME: root };
	const path = join(root, "devin/config.json");
	try {
		expect(skipDevinPluginHook("capture-stop", env)).toBe(false);
		mkdirSync(join(root, "devin"));
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{ command: "tedix hooks capture-stop --host devin || true" },
							],
						},
					],
				},
			}),
		);
		expect(skipDevinPluginHook("capture-stop", env)).toBe(false);
		writeFileSync(
			path,
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{
									command:
										"'tedix' hooks capture-stop --host devin || true # tedix-managed-devin-hook",
								},
							],
						},
					],
				},
			}),
		);
		expect(skipDevinPluginHook("capture-stop", env)).toBe(true);
		expect(skipDevinPluginHook("capture-reply", env)).toBe(false);
		writeFileSync(path, "invalid JSON");
		expect(skipDevinPluginHook("capture-stop", env)).toBe(false);
		expect(
			skipDevinPluginHook("capture-stop", {
				...env,
				TEDIX_DEVIN_LANE_ROOT: root,
			}),
		).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("plugin flag skips lane duplicates before reading stdin", async () => {
	const previous = process.env.TEDIX_DEVIN_LANE_ROOT;
	try {
		process.env.TEDIX_DEVIN_LANE_ROOT = "/example/lane";
		expect(
			await runHooksCommand(["capture-stop", "--host", "devin", "--plugin"]),
		).toBe(0);
	} finally {
		if (previous === undefined) delete process.env.TEDIX_DEVIN_LANE_ROOT;
		else process.env.TEDIX_DEVIN_LANE_ROOT = previous;
	}
});
