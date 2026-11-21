import { execFileSync } from "node:child_process";
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
const commit = execFileSync("git", ["rev-parse", "--short=9", "HEAD"], {
	cwd: root,
	encoding: "utf8",
}).trim();
const binary = join(root, "dist", `tedix-${version}-${os}-${arch}`);
for (const release of [false, true]) {
	const build = Bun.spawnSync(
		[
			"bun",
			"scripts/build-standalone.ts",
			target,
			...(release ? ["--release"] : []),
		],
		{ cwd: root, stderr: "inherit", stdout: "inherit" },
	);
	if (build.exitCode !== 0) process.exit(build.exitCode);
	const result = Bun.spawnSync([binary, "--version"], {
		cwd: root,
		stderr: "inherit",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) process.exit(result.exitCode);
	const reported = result.stdout.toString().trim();
	const expected = release ? version : `${version}+${commit}`;
	if (reported !== expected) {
		throw new Error(`Standalone reported ${reported}; expected ${expected}`);
	}
	console.log(
		`standalone ${release ? "release" : "local"} ${reported} ok (${os}-${arch})`,
	);
}
