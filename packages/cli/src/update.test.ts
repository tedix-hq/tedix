import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import {
	compareVersions,
	runRollbackCommand,
	runUpdateCommand,
	type UpdateRuntime,
	type VersionProbe,
} from "./update";
import { CLI_VERSION } from "./shared";

/** A release always newer than the CLI under test, whatever its own version. */
const NEXT_VERSION = "99.0.0";

function script(version: string): string {
	return `#!/bin/sh\nprintf '%s\\n' '${version}'\n`;
}

function fixture(options?: {
	artifactBody?: string;
	assetSize?: number;
	homebrewManaged?: boolean;
	version?: string;
	scriptBody?: string;
	chunkDelayMs?: number;
	stallAfterFirst?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "tedix-update-"));
	const installDir = join(root, "bin");
	const configDir = join(root, "config");
	const installPath = join(installDir, "tedix");
	const version = options?.version ?? NEXT_VERSION;
	const body = options?.scriptBody ?? script(version);
	const artifactBody = options?.artifactBody ?? body;
	const os = process.platform === "darwin" ? "darwin" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const name = `tedix-${version}-${os}-${arch}`;
	mkdirSync(installDir, { recursive: true });
	if (options?.homebrewManaged) {
		const cellarDir = join(root, "Cellar", "tedix", "0.1.0", "bin");
		const cellarPath = join(cellarDir, "tedix");
		mkdirSync(cellarDir, { recursive: true });
		writeFileSync(cellarPath, script("0.1.0"), { mode: 0o755 });
		chmodSync(cellarPath, 0o755);
		symlinkSync(cellarPath, installPath);
	} else {
		writeFileSync(installPath, script("0.1.0"), { mode: 0o755 });
		chmodSync(installPath, 0o755);
	}
	const requests = new Map<string, number>();
	const requestDetails: Array<{
		cacheControl: string | null;
		path: string;
		search: string;
	}> = [];
	let server: Bun.Server<undefined>;
	server = Bun.serve({
		port: 0,
		fetch(request): Response {
			const url = new URL(request.url);
			const path = url.pathname;
			requestDetails.push({
				cacheControl: request.headers.get("cache-control"),
				path,
				search: url.search,
			});
			requests.set(path, (requests.get(path) ?? 0) + 1);
			const baseUrl = `http://127.0.0.1:${server.port}`;
			if (path === "/latest.json") {
				return Response.json({
					manifestUrl: `${baseUrl}/releases/${version}/manifest.json`,
					schemaVersion: 1,
					sourceSha: "a".repeat(40),
					version,
				});
			}
			if (path === `/releases/${version}/manifest.json`) {
				return Response.json({
					assets: [
						{
							name,
							sha256: createHash("sha256").update(body).digest("hex"),
							size: options?.assetSize ?? Buffer.byteLength(body),
							url: `${baseUrl}/releases/${version}/${name}`,
						},
					],
					schemaVersion: 1,
					sourceSha: "a".repeat(40),
					version,
				});
			}
			if (path === `/releases/${version}/${name}`) {
				let cancelled = false;
				return new Response(
					new ReadableStream({
						async start(controller) {
							const bytes = new TextEncoder().encode(artifactBody);
							if (options?.chunkDelayMs || options?.stallAfterFirst) {
								for (let i = 0; i < bytes.length; i += 4) {
									if (cancelled) return;
									controller.enqueue(bytes.slice(i, i + 4));
									if (options.stallAfterFirst) return;
									await Bun.sleep(options.chunkDelayMs ?? 0);
								}
							} else controller.enqueue(bytes);
							controller.close();
						},
						cancel() {
							cancelled = true;
						},
					}),
				);
			}
			return new Response("Not Found", { status: 404 });
		},
	});
	const runtime: UpdateRuntime = {
		baseUrl: `http://127.0.0.1:${server.port}`,
		configDir,
		installPath,
		standalone: true,
	};
	return {
		close() {
			server.stop(true);
			rmSync(root, { force: true, recursive: true });
		},
		installPath,
		cachePath: join(configDir, "update-check.json"),
		requests,
		requestDetails,
		runtime,
		version,
		metadata() {
			const baseUrl = `http://127.0.0.1:${server.port}`;
			const latest = {
				manifestUrl: `${baseUrl}/releases/${version}/manifest.json`,
				schemaVersion: 1,
				sourceSha: "a".repeat(40),
				version,
			};
			const manifest = {
				assets: [
					{
						name,
						sha256: createHash("sha256").update(body).digest("hex"),
						size: options?.assetSize ?? Buffer.byteLength(body),
						url: `${baseUrl}/releases/${version}/${name}`,
					},
				],
				schemaVersion: 1,
				sourceSha: "a".repeat(40),
				version,
			};
			return { latest, manifest };
		},
	};
}

/**
 * In-memory `--version` probes that only end when the update code kills them.
 * A "stuck" probe never writes or exits; a "noisy" probe prints a plausible
 * version and then streams stderr forever. Neither touches a real process or
 * the wall clock: on macOS the first exec of a freshly written file pays a
 * synchronous Gatekeeper assessment that stretches from ~200 ms to seconds
 * under load, which is what made the real-process version of these tests
 * time-dependent.
 */
function fakeProbes(kind: "stuck" | "noisy") {
	const state = { killed: false, emitted: 0, paths: [] as string[] };
	const spawnVersionProbe = (path: string): VersionProbe => {
		state.paths.push(path);
		let resolveExit: (code: number | null) => void = () => {};
		const exited = new Promise<number | null>((resolve) => {
			resolveExit = resolve;
		});
		const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
		const kill = () => {
			state.killed = true;
			for (const controller of controllers) controller.close();
			resolveExit(null);
		};
		const stream = (
			pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
		) =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controllers.push(controller);
				},
				pull(controller) {
					if (!state.killed) pull(controller);
				},
			});
		const chunk = new TextEncoder().encode("noisy\n".repeat(1024));
		return {
			exited,
			kill,
			stdout: stream((controller) => {
				if (kind === "noisy" && state.emitted === 0) {
					const version = new TextEncoder().encode(`${NEXT_VERSION}\n`);
					state.emitted += version.byteLength;
					controller.enqueue(version);
				}
			}),
			stderr: stream((controller) => {
				if (kind === "noisy") {
					state.emitted += chunk.byteLength;
					controller.enqueue(chunk);
				}
			}),
		};
	};
	return { spawnVersionProbe, state };
}

describe("compareVersions", () => {
	test("implements SemVer precedence without lossy numeric conversion", () => {
		expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
		expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(
			0,
		);
		expect(compareVersions("1.0.0-beta.11", "1.0.0-rc.1")).toBeLessThan(0);
		expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0+one", "1.0.0+two")).toBe(0);
		expect(
			compareVersions(
				"999999999999999999999999999999.0.0",
				"1000000000000000000000000000000.0.0",
			),
		).toBeLessThan(0);
	});

	test("rejects incomplete and non-canonical versions", () => {
		expect(() => compareVersions("1.0", "1.0.0")).toThrow("Invalid");
		expect(() => compareVersions("01.0.0", "1.0.0")).toThrow("Invalid");
		expect(() => compareVersions("1.0.0-01", "1.0.0")).toThrow("Invalid");
		expect(() => compareVersions("1.0.0-alpha..1", "1.0.0")).toThrow("Invalid");
	});
});

describe("CLI update lifecycle", () => {
	test("continues a slow download while bytes arrive and reports progress only in human mode", async () => {
		for (const json of [false, true]) {
			const fixtureData = fixture({ chunkDelayMs: 25 });
			const notices = spyOn(console, "error").mockImplementation(() => {});
			const output = spyOn(console, "log").mockImplementation(() => {});
			try {
				await runUpdateCommand(
					{ check: false, force: false, json, version: fixtureData.version },
					{
						...fixtureData.runtime,
						downloadIdleTimeoutMs: 150,
						downloadTimeoutMs: 2000,
					},
				);
				expect(readFileSync(fixtureData.installPath, "utf8")).toBe(
					script(fixtureData.version),
				);
				expect(existsSync(`${fixtureData.installPath}.update.lock`)).toBe(
					false,
				);
				if (json) {
					expect(notices).not.toHaveBeenCalled();
					expect(output).toHaveBeenCalledTimes(1);
					expect(JSON.parse(String(output.mock.calls[0]?.[0])).changed).toBe(
						true,
					);
				} else {
					const text = notices.mock.calls.flat().join("\n");
					expect(text).toContain(`Current version: ${CLI_VERSION}`);
					expect(text).toContain(`Checking release ${fixtureData.version}…`);
					expect(text).toContain(
						`Updating Tedix from ${CLI_VERSION} to ${fixtureData.version} via standalone download…`,
					);
					expect(text).toContain("100%");
					expect(text).toContain("Verifying downloaded executable");
					expect(output).toHaveBeenCalledWith(
						`\n🎉 Successfully updated Tedix from ${CLI_VERSION} to ${fixtureData.version}!\nRestart any running Tedix sessions to use the new version.`,
					);
				}
			} finally {
				notices.mockRestore();
				output.mockRestore();
				fixtureData.close();
			}
		}
	});

	test("reports an up-to-date install without downloading or suggesting a restart", async () => {
		for (const check of [false, true]) {
			const data = fixture({ version: CLI_VERSION });
			const notices = spyOn(console, "error").mockImplementation(() => {});
			const output = spyOn(console, "log").mockImplementation(() => {});
			try {
				await runUpdateCommand(
					{ check, force: false, json: false },
					data.runtime,
				);
				expect(notices.mock.calls.flat()).toEqual([
					`Current version: ${CLI_VERSION}`,
					"Checking for updates to latest version…",
				]);
				expect(output.mock.calls.flat()).toEqual([
					`Tedix is up to date (version ${CLI_VERSION}).`,
				]);
				expect(existsSync(`${data.installPath}.previous`)).toBe(false);
				expect(
					data.requests.has(
						new URL(data.metadata().manifest.assets[0]!.url).pathname,
					),
				).toBe(false);
			} finally {
				notices.mockRestore();
				output.mockRestore();
				data.close();
			}
		}
	});

	test("gives check-only users the command for the release they checked", async () => {
		for (const exact of [false, true]) {
			const data = fixture();
			const notices = spyOn(console, "error").mockImplementation(() => {});
			const output = spyOn(console, "log").mockImplementation(() => {});
			try {
				await runUpdateCommand(
					{
						check: true,
						force: false,
						json: false,
						...(exact ? { version: data.version } : {}),
					},
					data.runtime,
				);
				expect(output.mock.calls.flat()).toEqual([
					`Tedix ${data.version} is available. Run \`tedix update${exact ? ` ${data.version}` : ""}\` to install it.`,
				]);
				expect(readFileSync(data.installPath, "utf8")).toBe(script("0.1.0"));
			} finally {
				notices.mockRestore();
				output.mockRestore();
				data.close();
			}
		}
	});

	test("describes a forced same-version install as a reinstall", async () => {
		const data = fixture({ version: CLI_VERSION });
		const notices = spyOn(console, "error").mockImplementation(() => {});
		const output = spyOn(console, "log").mockImplementation(() => {});
		try {
			await runUpdateCommand(
				{ check: false, force: true, json: false },
				data.runtime,
			);
			expect(notices.mock.calls.flat().join("\n")).toContain(
				`Reinstalling Tedix ${CLI_VERSION} via standalone download…`,
			);
			expect(output).toHaveBeenCalledWith(
				`\n🎉 Successfully reinstalled Tedix ${CLI_VERSION}!\nRestart any running Tedix sessions to use the new version.`,
			);
			expect(readFileSync(data.installPath, "utf8")).toBe(script(CLI_VERSION));
		} finally {
			notices.mockRestore();
			output.mockRestore();
			data.close();
		}
	});

	test("aborts idle and over-budget downloads without replacing the install or leaving locks", async () => {
		for (const stalled of [true, false]) {
			const fixtureData = fixture({
				stallAfterFirst: stalled,
				chunkDelayMs: 25,
			});
			try {
				await expect(
					runUpdateCommand(
						{
							check: false,
							force: false,
							json: true,
							version: fixtureData.version,
						},
						{
							...fixtureData.runtime,
							downloadIdleTimeoutMs: 150,
							downloadTimeoutMs: stalled ? 2000 : 200,
						},
					),
				).rejects.toThrow(stalled ? "stalled" : "exceeded");
				expect(readFileSync(fixtureData.installPath, "utf8")).toBe(
					script("0.1.0"),
				);
				expect(readdirSync(dirname(fixtureData.installPath))).toEqual([
					"tedix",
				]);
			} finally {
				fixtureData.close();
			}
		}
	});

	test("names metadata failures before any mutation", async () => {
		const fixtureData = fixture();
		try {
			await expect(
				runUpdateCommand(
					{ check: false, force: false, json: true },
					{
						...fixtureData.runtime,
						fetch: Object.assign(
							async () => {
								throw new DOMException(
									"The operation timed out.",
									"TimeoutError",
								);
							},
							{ preconnect: fetch.preconnect },
						),
					},
				),
			).rejects.toThrow("Release metadata could not be read");
			expect(readdirSync(dirname(fixtureData.installPath))).toEqual(["tedix"]);
		} finally {
			fixtureData.close();
		}
	});

	test("terminates stuck and noisy downloaded version probes while preserving both binaries", async () => {
		for (const kind of ["stuck", "noisy"] as const) {
			const fixtureData = fixture();
			const previous = `${fixtureData.installPath}.previous`;
			writeFileSync(previous, script("0.0.9"), { mode: 0o755 });
			const probes = fakeProbes(kind);
			try {
				await expect(
					runUpdateCommand(
						{
							check: false,
							force: false,
							json: true,
							version: fixtureData.version,
						},
						{
							...fixtureData.runtime,
							spawnVersionProbe: probes.spawnVersionProbe,
							// A stuck probe is ended by the deadline alone, so it fires
							// at once; a noisy probe must be ended by its output volume
							// long before a deadline it would never reach.
							versionTimeoutMs: kind === "noisy" ? 10_000 : 0,
						},
					),
				).rejects.toThrow("version smoke test");
				expect(probes.state.killed).toBe(true);
				expect(probes.state.paths).toHaveLength(1);
				expect(probes.state.paths[0]).toStartWith(
					`${fixtureData.installPath}.download-`,
				);
				if (kind === "noisy") {
					expect(probes.state.emitted).toBeGreaterThan(64 * 1024);
				} else expect(probes.state.emitted).toBe(0);
				expect(readFileSync(fixtureData.installPath, "utf8")).toBe(
					script("0.1.0"),
				);
				expect(readFileSync(previous, "utf8")).toBe(script("0.0.9"));
				expect(readdirSync(dirname(fixtureData.installPath)).sort()).toEqual([
					"tedix",
					"tedix.previous",
				]);
			} finally {
				fixtureData.close();
			}
		}
	});

	test("terminates a stuck rollback probe and retains the active install", async () => {
		const fixtureData = fixture();
		const previous = `${fixtureData.installPath}.previous`;
		const body = script("0.0.9");
		writeFileSync(previous, body, { mode: 0o755 });
		const probes = fakeProbes("stuck");
		try {
			await expect(
				runRollbackCommand(
					{ json: true },
					{
						...fixtureData.runtime,
						spawnVersionProbe: probes.spawnVersionProbe,
						versionTimeoutMs: 0,
					},
				),
			).rejects.toThrow("version smoke test");
			expect(probes.state.killed).toBe(true);
			expect(probes.state.paths).toEqual([previous]);
			expect(readFileSync(previous, "utf8")).toBe(body);
			expect(readFileSync(fixtureData.installPath, "utf8")).toBe(
				script("0.1.0"),
			);
			expect(readdirSync(dirname(fixtureData.installPath)).sort()).toEqual([
				"tedix",
				"tedix.previous",
			]);
		} finally {
			fixtureData.close();
		}
	});

	test("checks an explicit published version without mutation", async () => {
		const test = fixture();
		try {
			await runUpdateCommand(
				{
					check: true,
					force: false,
					json: true,
					version: test.version,
				},
				test.runtime,
			);
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
			expect(existsSync(`${test.installPath}.previous`)).toBe(false);
			expect(test.requests.get("/latest.json")).toBeUndefined();
			const manifestRequest = test.requestDetails.find((request) =>
				request.path.endsWith("/manifest.json"),
			);
			expect(manifestRequest).toMatchObject({
				cacheControl: null,
				search: "",
			});
		} finally {
			test.close();
		}
	});

	test("cache-busts only mutable latest metadata with the runtime clock", async () => {
		const test = fixture();
		try {
			await runUpdateCommand(
				{ check: true, force: false, json: true },
				{ ...test.runtime, now: () => 123_456 },
			);
			const latestRequest = test.requestDetails.find(
				(request) => request.path === "/latest.json",
			);
			expect(latestRequest).toEqual({
				cacheControl: "no-cache",
				path: "/latest.json",
				search: "?t=123456",
			});
			const manifestRequest = test.requestDetails.find((request) =>
				request.path.endsWith("/manifest.json"),
			);
			expect(manifestRequest).toMatchObject({
				cacheControl: null,
				search: "",
			});
		} finally {
			test.close();
		}
	});

	test("removes a local latest cache older than the running CLI", async () => {
		const test = fixture({ version: "0.0.1" });
		try {
			expect(compareVersions(test.version, CLI_VERSION)).toBeLessThan(0);
			const { latest, manifest } = test.metadata();
			mkdirSync(dirname(test.cachePath), { recursive: true });
			writeFileSync(
				test.cachePath,
				`${JSON.stringify({
					baseUrl: test.runtime.baseUrl,
					checkedAt: 0,
					latest,
					manifest,
				})}\n`,
			);
			await runUpdateCommand(
				{ check: true, force: false, json: true },
				{ ...test.runtime, now: () => 4_000_000 },
			);
			expect(test.requests.get("/latest.json")).toBe(1);
			expect(existsSync(test.cachePath)).toBe(false);
		} finally {
			test.close();
		}
	});

	test("does not persist a freshly fetched older latest alias", async () => {
		const test = fixture({ version: "0.0.1" });
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				await runUpdateCommand(
					{ check: true, force: false, json: true },
					{ ...test.runtime, now: () => 700 + attempt },
				);
			}
			expect(test.requests.get("/latest.json")).toBe(2);
			expect(existsSync(test.cachePath)).toBe(false);
		} finally {
			test.close();
		}
	});

	test("treats an older implicit latest alias as unchanged, not a downgrade request", async () => {
		const test = fixture({ version: "0.0.1" });
		try {
			await expect(
				runUpdateCommand(
					{ check: false, force: false, json: true },
					test.runtime,
				),
			).resolves.toBe(0);
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
			await expect(
				runUpdateCommand(
					{
						check: false,
						force: false,
						json: true,
						version: test.version,
					},
					test.runtime,
				),
			).rejects.toThrow("Refusing to downgrade");
		} finally {
			test.close();
		}
	});

	test("throttles repeated latest checks with verified cached metadata", async () => {
		const test = fixture();
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				await runUpdateCommand(
					{ check: true, force: false, json: true },
					test.runtime,
				);
			}
			expect(test.requests.get("/latest.json")).toBe(1);
			expect(test.requests.get(`/releases/${test.version}/manifest.json`)).toBe(
				1,
			);
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
		} finally {
			test.close();
		}
	});

	test("installs and rolls back while retaining an atomic previous point", async () => {
		const test = fixture();
		try {
			await runUpdateCommand(
				{
					check: false,
					force: false,
					json: true,
					version: test.version,
				},
				test.runtime,
			);
			expect(
				Bun.spawnSync([test.installPath, "--version"]).stdout.toString().trim(),
			).toBe(test.version);
			expect(
				Bun.spawnSync([`${test.installPath}.previous`, "--version"])
					.stdout.toString()
					.trim(),
			).toBe("0.1.0");

			await runRollbackCommand({ json: true }, test.runtime);
			expect(
				Bun.spawnSync([test.installPath, "--version"]).stdout.toString().trim(),
			).toBe("0.1.0");
			expect(
				Bun.spawnSync([`${test.installPath}.previous`, "--version"])
					.stdout.toString()
					.trim(),
			).toBe(test.version);
		} finally {
			test.close();
		}
	});

	test("fails closed when another updater owns the install lock", async () => {
		const test = fixture();
		try {
			writeFileSync(`${test.installPath}.update.lock`, "held\n", {
				mode: 0o600,
			});
			await expect(
				runUpdateCommand(
					{
						check: false,
						force: false,
						json: true,
						version: test.version,
					},
					test.runtime,
				),
			).rejects.toThrow("already active");
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
		} finally {
			test.close();
		}
	});

	test("rejects source-checkout mutation before touching an install path", async () => {
		const test = fixture();
		try {
			await expect(
				runUpdateCommand(
					{
						check: false,
						force: false,
						json: true,
						version: test.version,
					},
					{ ...test.runtime, standalone: false },
				),
			).rejects.toThrow("source checkout");
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
		} finally {
			test.close();
		}
	});

	test("leaves Homebrew-owned binaries to the package manager", async () => {
		const test = fixture({ homebrewManaged: true });
		try {
			await runUpdateCommand(
				{ check: true, force: false, json: true },
				test.runtime,
			);
			await expect(
				runUpdateCommand(
					{
						check: false,
						force: false,
						json: true,
						version: test.version,
					},
					test.runtime,
				),
			).rejects.toThrow("brew upgrade tedix-hq/tap/tedix");
			await expect(
				runRollbackCommand({ json: true }, test.runtime),
			).rejects.toThrow("package-manager-owned");
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
			expect(existsSync(`${test.installPath}.previous`)).toBe(false);
		} finally {
			test.close();
		}
	});

	test("bounds streamed artifacts and leaves the active binary intact", async () => {
		const body = script(NEXT_VERSION);
		const test = fixture({
			artifactBody: `${body}unexpected`,
			assetSize: Buffer.byteLength(body),
		});
		try {
			await expect(
				runUpdateCommand(
					{
						check: false,
						force: false,
						json: true,
						version: test.version,
					},
					test.runtime,
				),
			).rejects.toThrow(/size mismatch|exceeded its declared size/);
			expect(readFileSync(test.installPath, "utf8")).toBe(script("0.1.0"));
			expect(existsSync(`${test.installPath}.previous`)).toBe(false);
		} finally {
			test.close();
		}
	});
});
