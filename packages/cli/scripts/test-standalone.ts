import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = String(
	(
		JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			version: string;
		}
	).version,
);
const os = process.platform === "darwin" ? "darwin" : process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";
const target = `bun-${os}-${arch}`;
const build = Bun.spawnSync(["bun", "scripts/build-standalone.ts", target], {
	cwd: root,
	stderr: "inherit",
	stdout: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode);

const binary = join(root, "dist", `tedix-${version}-${os}-${arch}`);
const result = Bun.spawnSync([binary, "--version"], {
	stderr: "inherit",
	stdout: "pipe",
});
if (result.exitCode !== 0) process.exit(result.exitCode);
const reported = result.stdout.toString().trim();
if (reported !== version) {
	throw new Error(`Standalone reported ${reported}; expected ${version}`);
}
console.log(`standalone ${reported} ok (${os}-${arch})`);
