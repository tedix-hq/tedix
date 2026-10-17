import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPANDED_HOOK_BYTES, HOOK_BYTES } from "../src/hooks/prompt-context";
import { pluginRepoFiles } from "./build-plugin-repo";
import {
	build,
	CLI_GATE,
	HOOK_GUARD,
	hookName as commandHook,
	MIN_CLI,
	packageFiles,
	ROOT,
} from "./package-plugin";

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

/** The hook name after the missing-CLI guard, or undefined for another command. */
const hookName = (handler: any): string | undefined =>
	commandHook(handler.command);

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
	test("every host artifact includes nested skill references", () =>
		withDirectory((directory) => {
			cpSync(ROOT, directory, { recursive: true });
			const path = "skills/tedix-resume-work/references/nested/lifecycle.md";
			mkdirSync(join(directory, "skills/tedix-resume-work/references/nested"), {
				recursive: true,
			});
			writeFileSync(join(directory, path), "Shipped lifecycle steps.\n");
			for (const host of ["openai", "claude"])
				for (const local of [false, true]) {
					const files = packageFiles({ root: directory, host, local });
					expect(new TextDecoder().decode(files.get(path))).toBe(
						"Shipped lifecycle steps.\n",
					);
				}
		}));

	test("lifecycle and factory procedures ship for every host and the public repository", () => {
		const artifacts = [pluginRepoFiles()];
		for (const host of ["openai", "claude"])
			for (const local of [false, true])
				artifacts.push(packageFiles({ host, local }));
		for (const path of [
			"skills/tedix-resume-work/references/work-lifecycle.md",
			"skills/tedix-session-guide/references/work-lifecycle.md",
			"skills/tedix-guardian-session/references/work-lifecycle.md",
			"skills/tedix-session-guide/references/factory-procedure.md",
		]) {
			const source = readFileSync(join(ROOT, path), "utf8");
			for (const files of artifacts)
				expect(new TextDecoder().decode(files.get(path) as Uint8Array)).toBe(
					source,
				);
		}
	});

	test("rejects symlinked skill files and directories", () =>
		withDirectory((directory) => {
			cpSync(ROOT, directory, { recursive: true });
			const link = join(directory, "skills/linked-reference");
			for (const target of [join(ROOT, "README.md"), join(ROOT, "skills")]) {
				symlinkSync(target, link);
				expect(() => packageFiles({ root: directory })).toThrow(
					/regular in-tree file or directory/,
				);
				rmSync(link);
			}
		}));

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
			(handler) => hookName(handler) === "status",
		);
		expect(status).toHaveLength(7);
		expect(status.every((handler) => handler.async === true)).toBe(true);
		// Recording handlers run in the background and cannot block or steer the session.
		const capture = handlers(hooks).filter((handler) =>
			hookName(handler)?.startsWith("capture-"),
		);
		expect(capture).toHaveLength(2);
		expect(capture.every((handler) => handler.async === true)).toBe(true);
		expect(handlers(hooks).every((handler) => hookName(handler))).toBe(true);
		expect(decode(local, ".codex-plugin/plugin.json").name).toBe("tedix");
		expect(
			decode(local, "plugin.json").extensions["com.openai"].publication
				.release_notes,
		).toContain("run by the installed Tedix CLI");
	});

	test("prompt context fits the limit both installed plugins declare", () => {
		// Installed Claude plugins run the source hooks.json; Codex runs the package.
		const declared = [
			JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks,
			decode(packageFiles({ local: true }), "hooks/hooks.json").hooks,
		].map((hooks) =>
			handlers(hooks)
				.filter((handler) => hookName(handler) === "prompt-context")
				.map((handler) => handler.additionalContextLimit),
		);
		expect(declared).toEqual([[10100], [10100]]);
		expect(HOOK_BYTES).toBeLessThan(6500);
		expect(EXPANDED_HOOK_BYTES).toBeLessThan(10100);
		for (const hooks of [
			JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8")).hooks,
			decode(packageFiles({ local: true }), "hooks/hooks.json").hooks,
		])
			expect(
				handlers(hooks).find(
					(handler) => hookName(handler) === "prompt-context",
				).command,
			).toContain(`TEDIX_HOOK_CONTEXT_BYTES=${EXPANDED_HOOK_BYTES}`);
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

	test("claude local hooks are guarded shell commands and not duplicated", () => {
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
					expect(handler).not.toHaveProperty("args");
					const name = hookName(handler);
					expect(name).toBeDefined();
					if (event === "SessionStart") expect(name).toBe("session-start");
					if (event === "Stop")
						expect(["capture-stop", "await-reply", "status"]).toContain(name);
					if (!["Stop", "UserPromptSubmit", "SessionStart"].includes(event))
						expect(name).toBe("status");
				}
		expect(
			[...files.keys()].filter((name) => name.startsWith("hooks/")),
		).toEqual(["hooks/hooks.json"]);
	});

	test("only Claude Code gets the background rewake hook", () => {
		const claude = handlers(
			decode(packageFiles({ host: "claude", local: true }), "hooks/hooks.json")
				.hooks,
		).filter((handler) => hookName(handler) === "await-reply");
		expect(claude).toHaveLength(1);
		expect(claude[0]!.asyncRewake).toBe(true);
		// Codex cannot be woken; a synchronous four-hour Stop would hold its turn.
		const openai = decode(packageFiles({ local: true }), "hooks/hooks.json");
		expect(
			handlers(openai.hooks).some(
				(handler) => handler.asyncRewake || hookName(handler) === "await-reply",
			),
		).toBe(false);
		expect(new Set(Object.keys(openai.hooks))).toEqual(EVENTS);
		// Codex continues from a synchronous Stop hook instead; Claude never gets it.
		const awaitDraft = handlers({ Stop: openai.hooks.Stop }).filter(
			(handler) => hookName(handler) === "await-draft",
		);
		expect(awaitDraft).toEqual([
			{
				type: "command",
				command: `${HOOK_GUARD}tedix hooks await-draft`,
				timeout: 320,
			},
		]);
		expect(
			handlers(
				decode(
					packageFiles({ host: "claude", local: true }),
					"hooks/hooks.json",
				).hooks,
			).some((handler) => hookName(handler) === "await-draft"),
		).toBe(false);
		expect(
			Object.values<any[]>(openai.hooks).every((definitions) =>
				definitions.every((definition) => definition.hooks.length > 0),
			),
		).toBe(true);
	});

	test("every source hook is guarded against a missing CLI", () => {
		const hooks = JSON.parse(
			readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"),
		).hooks;
		expect(handlers(hooks).every((handler) => hookName(handler))).toBe(true);
	});

	test.skipIf(!Bun.which("sh"))(
		"the guard is a silent no-op without the CLI and transparent with it",
		() =>
			withDirectory((directory) => {
				const sh = Bun.which("sh")!;
				const command = `${HOOK_GUARD}tedix hooks await-reply`;
				const missing = Bun.spawnSync([sh, "-c", command], {
					env: { PATH: directory },
				});
				expect(missing.exitCode).toBe(0);
				expect(missing.stdout.toString()).toBe("");
				expect(missing.stderr.toString()).toBe("");
				const cli = join(directory, "tedix");
				writeFileSync(cli, '#!/bin/sh\necho "$@" >&2\nexit 2\n');
				chmodSync(cli, 0o755);
				const present = Bun.spawnSync([sh, "-c", command], {
					env: { PATH: `${directory}:/usr/bin:/bin` },
				});
				expect(present.exitCode).toBe(2);
				expect(present.stderr.toString()).toBe("hooks await-reply\n");
			}),
	);

	test("the README states the minimum CLI that session-start enforces", () => {
		expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(
			`The local hooks need Tedix CLI ${MIN_CLI} or later.`,
		);
	});

	test.skipIf(!Bun.which("sh") || !Bun.which("sort"))(
		"session-start names an older CLI and runs the preflight on a current one",
		() =>
			withDirectory((directory) => {
				const sh = Bun.which("sh")!;
				const command = `${HOOK_GUARD}${CLI_GATE}tedix hooks session-start`;
				const cli = join(directory, "tedix");
				const run = (version: string) => {
					writeFileSync(
						cli,
						`#!/bin/sh\n[ "$1" = --version ] && echo ${version} && exit 0\necho "$@"\n`,
					);
					chmodSync(cli, 0o755);
					const result = Bun.spawnSync([sh, "-c", command], {
						env: { PATH: `${directory}:/usr/bin:/bin` },
					});
					expect(result.exitCode).toBe(0);
					return result.stdout.toString();
				};
				expect(run("0.8.15")).toBe(
					`Tedix preflight: CLI 0.8.15 is older than ${MIN_CLI}, which this plugin needs; run tedix update.\n`,
				);
				for (const version of [MIN_CLI, "0.8.100", "0.10.0", "1.0.0"])
					expect(run(version)).toBe("hooks session-start\n");
			}),
	);

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

test("local SessionStart hooks have room and time for the open request ledger", () => {
	const openai = decode(
		packageFiles({ local: true }),
		"hooks/hooks.json",
	).hooks;
	const start = handlers(openai).find(
		(handler) => hookName(handler) === "session-start",
	);
	expect(start.timeout).toBe(30);
	expect(start.additionalContextLimit).toBeGreaterThanOrEqual(
		EXPANDED_HOOK_BYTES,
	);
	const claude = decode(
		packageFiles({ host: "claude", local: true }),
		"hooks/hooks.json",
	).hooks;
	expect(
		handlers(claude).find((handler) => hookName(handler) === "session-start")
			.timeout,
	).toBe(30);
});
