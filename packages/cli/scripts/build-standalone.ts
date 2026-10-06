import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	version: string;
};
const target = process.argv[2];
const hostOs = process.platform === "darwin" ? "darwin" : process.platform;
const hostArch = process.arch === "arm64" ? "arm64" : "x64";
const resolvedTarget = target ?? `bun-${hostOs}-${hostArch}`;
const [runtime, os, arch] = resolvedTarget.split("-");
if (runtime !== "bun" || !os || !arch) {
	throw new Error(`Invalid Bun compile target: ${resolvedTarget}`);
}

const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const extension = os === "windows" ? ".exe" : "";
const outfile = join(dist, `tedix-${pkg.version}-${os}-${arch}${extension}`);
const tempDirs = [root, join(root, "../..")];
const existingTemps = new Set(
	tempDirs.flatMap((dir) =>
		readdirSync(dir)
			.filter((name) => name.endsWith(".bun-build"))
			.map((name) => join(dir, name)),
	),
);
const cleanupTemps = () => {
	for (const dir of tempDirs) {
		for (const name of readdirSync(dir).filter((entry) =>
			entry.endsWith(".bun-build"),
		)) {
			const path = join(dir, name);
			if (!existingTemps.has(path)) unlinkSync(path);
		}
	}
};
const result = await Bun.build({
	entrypoints: [join(root, "src/index.ts")],
	root,
	compile: {
		outfile,
		target: resolvedTarget as Bun.Build.CompileTarget,
	},
	define: {
		__TEDIX_CLI_VERSION__: JSON.stringify(pkg.version),
	},
	minify: true,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	cleanupTemps();
	process.exit(1);
}
cleanupTemps();
if (!extension) chmodSync(outfile, 0o755);
console.log(outfile);
