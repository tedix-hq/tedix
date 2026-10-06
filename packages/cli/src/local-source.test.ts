import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	acquireLocalSource,
	findSourceRoot,
	readLocalInstallation,
	saveLocalInstallation,
} from "./local-source";
import { parseSetupArguments } from "./local-installation";

const temporary: string[] = [];
function directory() {
	const value = mkdtempSync(join(tmpdir(), "tedix-onboarding-"));
	temporary.push(value);
	return value;
}
function source(root: string) {
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts/run-local.ts"), "// fixture");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tedix" }));
}
afterEach(() => {
	for (const path of temporary.splice(0))
		rmSync(path, { recursive: true, force: true });
});
const sha = "a".repeat(40);
const version = "0.1.0-beta.55";
const manifest = { version, tag: `cli-v${version}`, sourceSha: sha };

describe("local onboarding", () => {
	test("CLI setup registers locally and dev resumes from another directory without gateway auth", () => {
		const config = directory();
		const checkout = join(config, "checkout");
		source(checkout);
		writeFileSync(
			join(checkout, "scripts/run-local.ts"),
			"console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),browser:process.env.TEDIX_LOCAL_OPEN_BROWSER,metrics:process.env.WRANGLER_SEND_METRICS,banner:process.env.WRANGLER_HIDE_BANNER}));",
		);
		const cli = resolve(import.meta.dir, "index.ts");
		const env = { ...process.env, TEDIX_CONFIG_DIR: config };
		const setup = Bun.spawnSync(
			[process.execPath, cli, "setup", "--yes", "--directory", checkout],
			{ cwd: config, env },
		);
		expect(setup.exitCode).toBe(0);
		expect(setup.stdout.toString()).toContain('"browser":"0"');
		expect(setup.stdout.toString()).toContain(
			'"metrics":"false","banner":"true"',
		);
		expect(readLocalInstallation(config)?.root).toBe(checkout);
		const elsewhere = directory();
		const dev = Bun.spawnSync([process.execPath, cli, "dev"], {
			cwd: elsewhere,
			env,
		});
		expect(dev.exitCode).toBe(0);
		expect(dev.stdout.toString()).toContain(
			JSON.stringify(realpathSync(checkout)),
		);
		expect(dev.stdout.toString()).toContain('"args":[]');
	});

	test("registers a checkout and mode for use outside its directory", () => {
		const config = directory();
		const root = join(config, "checkout");
		source(root);
		const args = [
			"--inference=workers-ai",
			`--workers-ai-account=${"b".repeat(32)}`,
			"--ai-gateway=beta-gateway",
		];
		saveLocalInstallation(root, args, config);
		expect(readLocalInstallation(config)).toEqual({
			version: 1,
			root,
			runnerArgs: args,
		});
		expect(findSourceRoot(join(root, "scripts"))).toBe(root);
		expect(findSourceRoot(join(config, "elsewhere"))).toBeUndefined();
	});
	test("rejects moved sources and untrusted persisted runner flags", () => {
		const config = directory();
		const root = join(config, "checkout");
		source(root);
		saveLocalInstallation(root, ["--inference=gateway"], config);
		expect(() => readLocalInstallation(config)).toThrow("registration");
		saveLocalInstallation(root, [], config);
		rmSync(root, { recursive: true });
		expect(() => readLocalInstallation(config)).toThrow("moved");
	});
	test("supports explicit offline setup and a chosen destination", () => {
		expect(
			parseSetupArguments(["--yes", "--directory", "/tmp/example"]),
		).toEqual({ yes: true, directory: "/tmp/example" });
		for (const args of [
			["--directory"],
			["--directory", "--yes"],
			["--yes", "--yes"],
			["--inference"],
		])
			expect(() => parseSetupArguments(args)).toThrow();
	});
	test("acquires the exact release and persists only verified source", async () => {
		const parent = directory();
		const destination = join(parent, "installation");
		const calls: string[][] = [];
		const result = await acquireLocalSource({
			version,
			destination,
			fetchManifest: async () => manifest,
			runGit: async (args) => {
				calls.push(args);
				if (args[0] === "clone") {
					source(args.at(-1)!);
					return "";
				}
				return sha;
			},
		});
		expect(result).toBe(destination);
		expect(findSourceRoot(destination)).toBe(destination);
		expect(calls[0]).toContain(`cli-v${version}`);
		expect(calls[0]).toContain("https://github.com/tedix-hq/tedix.git");
	});
	test("never overwrites an occupied destination", async () => {
		const destination = directory();
		writeFileSync(join(destination, "keep"), "mine");
		await expect(
			acquireLocalSource({
				version,
				destination,
				fetchManifest: async () => {
					throw new Error("must not fetch");
				},
			}),
		).rejects.toThrow("already exists");
		expect(readFileSync(join(destination, "keep"), "utf8")).toBe("mine");
	});
	test("rejects a mismatched checkout before activation", async () => {
		const destination = join(directory(), "installation");
		await expect(
			acquireLocalSource({
				version,
				destination,
				fetchManifest: async () => manifest,
				runGit: async (args) => {
					if (args[0] === "clone") source(args.at(-1)!);
					return "b".repeat(40);
				},
			}),
		).rejects.toThrow("does not match");
		expect(existsSync(destination)).toBe(false);
	});
	test("rejects an invalid manifest before cloning", async () => {
		await expect(
			acquireLocalSource({
				version,
				destination: join(directory(), "installation"),
				fetchManifest: async () => ({ ...manifest, version: "other" }),
				runGit: async () => {
					throw new Error("must not clone");
				},
			}),
		).rejects.toThrow("manifest");
	});
	test("a failed clone leaves no registered or active installation", async () => {
		const destination = join(directory(), "installation");
		await expect(
			acquireLocalSource({
				version,
				destination,
				fetchManifest: async () => manifest,
				runGit: async () => {
					throw new Error("authentication failed");
				},
			}),
		).rejects.toThrow("authentication failed");
		expect(existsSync(destination)).toBe(false);
	});
});
