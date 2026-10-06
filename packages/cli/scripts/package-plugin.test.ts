import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, packageFiles, ROOT } from "./package-plugin";

const decode = (files: Map<string, Uint8Array>, name: string) =>
	JSON.parse(new TextDecoder().decode(files.get(name)!));
const EVENTS = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"Stop",
	"StopFailure",
	"PermissionRequest",
	"Notification",
	"PostToolUse",
	"SessionEnd",
]);

function handlers(hooks: Record<string, any[]>): any[] {
	return Object.values(hooks).flatMap((definitions) =>
		definitions.flatMap((definition) => definition.hooks),
	);
}

/** Entry names from a stored ZIP's central directory. */
function zipNames(archive: Buffer): string[] {
	const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	let offset = archive.readUInt32LE(end + 16);
	const names: string[] = [];
	for (let i = 0; i < archive.readUInt16LE(end + 10); i++) {
		const length = archive.readUInt16LE(offset + 28);
		names.push(
			archive.subarray(offset + 46, offset + 46 + length).toString("utf8"),
		);
		offset +=
			46 +
			length +
			archive.readUInt16LE(offset + 30) +
			archive.readUInt16LE(offset + 32);
	}
	return names;
}

function withDirectory(run: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "tedix-plugin-"));
	try {
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("plugin packager", () => {
	test("cloud has one identity and no local or operational files", () => {
		const files = packageFiles();
		expect(files.has("skills/tedix-session-guide/SKILL.md")).toBe(true);
		expect(files.has("mcp.json")).toBe(true);
		expect(
			[...files.keys()].some((name) => /^(hooks\/|review\/|\.)/.test(name)),
		).toBe(false);
		expect([...files.keys()].some((name) => /\.(py|ts)$/.test(name))).toBe(
			false,
		);
		expect(decode(files, "plugin.json").name).toBe("tedix");
		expect(
			decode(files, "plugin.json").extensions["com.openai"].review.test_cases,
		).toEqual(
			JSON.parse(readFileSync(join(ROOT, "review/cases.json"), "utf8")),
		);
	});

	test("local adds only hooks.json and compatibility manifests", () => {
		const cloud = packageFiles();
		const local = packageFiles({ local: true });
		expect(
			new Set([...local.keys()].filter((name) => !cloud.has(name))),
		).toEqual(
			new Set([
				".mcp.json",
				".claude-plugin/plugin.json",
				".codex-plugin/plugin.json",
				"hooks/hooks.json",
			]),
		);
		const hooks = decode(local, "hooks/hooks.json").hooks;
		expect(new Set(Object.keys(hooks))).toEqual(EVENTS);
		// The status reporter observes every turn boundary but always runs in the background.
		const status = handlers(hooks).filter(
			(handler) => handler.command === "tedix hooks status",
		);
		expect(status).toHaveLength(7);
		expect(status.every((handler) => handler.async === true)).toBe(true);
		// Recording handlers run in the background and cannot block or steer the session.
		const capture = handlers(hooks).filter((handler) =>
			handler.command.startsWith("tedix hooks capture-"),
		);
		expect(capture).toHaveLength(2);
		expect(capture.every((handler) => handler.async === true)).toBe(true);
		expect(
			handlers(hooks).every((handler) =>
				handler.command.startsWith("tedix hooks "),
			),
		).toBe(true);
		expect(decode(local, ".codex-plugin/plugin.json").name).toBe("tedix");
		expect(
			decode(local, "plugin.json").extensions["com.openai"].publication
				.release_notes,
		).toContain("run by the installed Tedix CLI");
	});

	test("reproducible and does not overwrite", () =>
		withDirectory((directory) => {
			const first = join(directory, "first.zip");
			const second = join(directory, "second.zip");
			build(first);
			build(second);
			expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
			expect(new Set(zipNames(readFileSync(first)))).toEqual(
				new Set(packageFiles().keys()),
			);
			expect(() => build(first)).toThrow(/EEXIST/);
		}));

	test.skipIf(!Bun.which("unzip"))("the archive is a valid stored ZIP", () =>
		withDirectory((directory) => {
			const path = join(directory, "plugin.zip");
			build(path, { local: true });
			const listing = Bun.spawnSync(["unzip", "-t", path]);
			expect(listing.stdout.toString()).toContain("No errors detected");
		}),
	);

	test("claude uses its native format and no cloud executables", () => {
		const files = packageFiles({ host: "claude" });
		expect(decode(files, ".claude-plugin/plugin.json").name).toBe("tedix");
		expect(decode(files, ".mcp.json")).toEqual({
			mcpServers: {
				tedix: { type: "http", url: "https://connect.mcp.tedix.dev/mcp" },
			},
		});
		expect(decode(files, ".mcp.json")).toEqual(
			JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")),
		);
		expect(files.has("plugin.json")).toBe(false);
		expect(files.has("mcp.json")).toBe(false);
		expect(
			[...files.keys()].some((name) =>
				/^(hooks\/|\.codex-plugin\/|review\/)/.test(name),
			),
		).toBe(false);
		expect(
			new Set([...files.keys()].filter((name) => name.startsWith("skills/"))),
		).toEqual(
			new Set(
				[...packageFiles().keys()].filter((name) => name.startsWith("skills/")),
			),
		);
	});

	test("claude local hooks are native exec form and not duplicated", () => {
		const files = packageFiles({ host: "claude", local: true });
		const manifest = decode(files, ".claude-plugin/plugin.json");
		expect(manifest).not.toHaveProperty("hooks");
		expect(manifest).not.toHaveProperty("mcpServers");
		const hooks = decode(files, "hooks/hooks.json").hooks;
		expect(new Set(Object.keys(hooks))).toEqual(EVENTS);
		for (const [event, definitions] of Object.entries<any[]>(hooks))
			for (const definition of definitions)
				for (const handler of definition.hooks) {
					expect(handler).not.toHaveProperty("additionalContextLimit");
					expect(handler.command).toBe("tedix");
					expect(handler.args[0]).toBe("hooks");
					if (event === "SessionStart")
						expect(handler.args).toEqual(["hooks", "session-start"]);
					if (event === "Stop")
						expect(["capture-stop", "status"]).toContain(handler.args[1]);
					if (!["Stop", "UserPromptSubmit", "SessionStart"].includes(event))
						expect(handler.args).toEqual(["hooks", "status"]);
				}
		expect(
			[...files.keys()].filter((name) => name.startsWith("hooks/")),
		).toEqual(["hooks/hooks.json"]);
	});

	test("explicit local endpoint and remote validation", () => {
		for (const url of [
			"http://localhost:8787/mcp",
			"http://127.0.0.1:8787/mcp",
			"http://[::1]:8787/mcp",
			"http://local-tedix-unified.localhost:3000/mcp",
		]) {
			const files = packageFiles({ host: "claude", local: true, mcpUrl: url });
			expect(decode(files, ".mcp.json").mcpServers.tedix.url).toBe(url);
			expect(() => packageFiles({ host: "claude", mcpUrl: url })).toThrow();
		}
		for (const url of [
			"http://example.com/mcp",
			"http://localhost.example.com/mcp",
			"http://.localhost/mcp",
			"https://user:secret@example.com/mcp",
			"https://example.com/mcp?token=secret",
			"https://example.com/mcp#token",
			"https://example.com:bad/mcp",
			"file:///tmp/mcp",
			"https://example.com\\evil/mcp",
		])
			expect(() =>
				packageFiles({ host: "claude", local: true, mcpUrl: url }),
			).toThrow();
		const files = packageFiles({
			host: "claude",
			mcpUrl: "https://example.com/mcp",
		});
		expect(decode(files, ".mcp.json").mcpServers.tedix.url).toBe(
			"https://example.com/mcp",
		);
		expect(() => packageFiles({ mcpUrl: "https://example.com/mcp" })).toThrow();
		expect(() => packageFiles({ host: "unknown" })).toThrow();
	});

	test("a local bearer is only an explicit environment reference", () => {
		const files = packageFiles({
			host: "claude",
			local: true,
			mcpUrl: "http://localhost:3000/mcp",
			mcpBearerEnv: "TEDIX_MCP_BEARER_TOKEN",
		});
		expect(decode(files, ".mcp.json").mcpServers.tedix.headers).toEqual({
			Authorization: "Bearer ${TEDIX_MCP_BEARER_TOKEN}",
		});
		for (const options of [
			{},
			{ host: "claude" },
			{ host: "claude", local: true },
			{
				host: "claude",
				local: true,
				mcpUrl: "http://localhost:3000/mcp",
				mcpBearerEnv: "secret-token",
			},
		])
			expect(() =>
				packageFiles({ mcpBearerEnv: "TOKEN", ...options }),
			).toThrow();
	});

	test("claude reproducible artifacts", () =>
		withDirectory((directory) => {
			for (const local of [false, true]) {
				const first = join(directory, `first-${local}.zip`);
				const second = join(directory, `second-${local}.zip`);
				build(first, { host: "claude", local });
				build(second, { host: "claude", local });
				expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
			}
		}));
});
