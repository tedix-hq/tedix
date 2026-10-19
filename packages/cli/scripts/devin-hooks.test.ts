import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devinHooksSchema } from "./devin-hooks";
import { ROOT } from "./package-plugin";

const read = (path: string) =>
	JSON.parse(readFileSync(join(ROOT, path), "utf8"));

test("Devin discovers only its event-keyed hooks configuration", () => {
	expect(devinHooksSchema.safeParse(read("hooks.json")).success).toBe(true);
	expect(existsSync(join(ROOT, "hooks/hooks.json"))).toBe(false);
});

test("rejects wrappers, unsupported events, and host-specific handler keys", () => {
	const hostHooks = read("config/host-hooks.json");
	expect(devinHooksSchema.safeParse(hostHooks).success).toBe(false);
	expect(devinHooksSchema.safeParse({ StopFailure: [] }).success).toBe(false);
	for (const field of [
		"async",
		"asyncRewake",
		"statusMessage",
		"additionalContextLimit",
	]) {
		expect(
			devinHooksSchema.safeParse({
				Stop: [
					{ hooks: [{ type: "command", command: "true", [field]: true }] },
				],
			}).success,
		).toBe(false);
	}
	expect(
		devinHooksSchema.safeParse({ Stop: [{ matcher: 123, hooks: [] }] }).success,
	).toBe(false);
	expect(
		devinHooksSchema.safeParse({
			Stop: [{ hooks: [{ type: "command", prompt: "wrong" }] }],
		}).success,
	).toBe(false);
});

test("Claude and both Codex manifest forms explicitly resolve the same host hooks", () => {
	const hooks = read("config/host-hooks.json");
	const manifests = [
		read(".claude-plugin/plugin.json"),
		read(".codex-plugin/plugin.json"),
		read("plugin.json").extensions["com.openai"],
	];
	for (const manifest of manifests) {
		expect(manifest.hooks).toBe("./config/host-hooks.json");
		expect(read(manifest.hooks)).toEqual(hooks);
	}
	expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain(
		"tedix hooks session-start",
	);
	expect(
		hooks.hooks.Stop.flatMap(
			(definition: { hooks: { asyncRewake?: boolean }[] }) => definition.hooks,
		).some((handler: { asyncRewake?: boolean }) => handler.asyncRewake),
	).toBe(true);
});
