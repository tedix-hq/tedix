import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arch = process.argv[2];
if (arch !== "arm64" && arch !== "x64") throw new Error("Choose arm64 or x64.");
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const work = mkdtempSync(join(tmpdir(), "tedix-local-package-"));
const runtime = join(work, "runtime");
const bin = join(runtime, "bin");
const output = join(desktop, "local-workspace", arch);
const rootPackage = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
);
const bunVersion = rootPackage.packageManager.replace(/^bun@/, "");
const nodeVersion = "26.13.1";
const nodeName = `node-v${nodeVersion}-darwin-${arch}`;
const bunName = `bun-darwin-${arch === "arm64" ? "aarch64" : "x64"}`;

function run(executable: string, args: string[], cwd = work) {
	execFileSync(executable, args, { cwd, stdio: "inherit" });
}

async function download(url: string): Promise<Buffer> {
	for (let attempt = 1; ; attempt++) {
		let response: Response | undefined;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
			if (response.ok) return Buffer.from(await response.arrayBuffer());
			await response.body?.cancel();
		} catch (error) {
			if (attempt === 3)
				throw new Error(`Could not download ${url}`, { cause: error });
		}
		if (response && !response.ok) {
			const { status } = response;
			if (attempt === 3 || (status !== 408 && status !== 429 && status < 500))
				throw new Error(`HTTP ${status} downloading ${url}`);
		}
		console.warn(`Retrying download of ${url} (${attempt + 1}/3)`);
		await Bun.sleep(attempt * 2_000);
	}
}

try {
	mkdirSync(bin, { recursive: true });
	const sources = join(work, "sources.tar");
	run("git", ["archive", "--format=tar", "-o", sources, "HEAD"], root);
	run("/usr/bin/tar", ["-xf", sources, "-C", runtime]);
	writeFileSync(
		join(runtime, "source-sha"),
		execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }),
	);

	const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`;
	const name = `${nodeName}.tar.gz`;
	const node = await download(`${nodeBase}/${name}`);
	const checksums = (await download(`${nodeBase}/SHASUMS256.txt`)).toString();
	const expected = checksums
		.split("\n")
		.find((line) => line.endsWith(`  ${name}`))
		?.slice(0, 64);
	if (expected !== createHash("sha256").update(node).digest("hex"))
		throw new Error("Node download failed its checksum.");
	writeFileSync(join(work, name), node);
	run("/usr/bin/tar", [
		"-xf",
		name,
		`${nodeName}/bin/node`,
		`${nodeName}/LICENSE`,
	]);
	cpSync(join(work, nodeName, "bin", "node"), join(bin, "node"));
	cpSync(join(work, nodeName, "LICENSE"), join(bin, "node.LICENSE"));

	const bunArchive = `${bunName}.zip`;
	const bunRelease = await download(
		`https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${bunVersion}`,
	);
	const metadata = JSON.parse(bunRelease.toString()) as {
		assets: { name: string; digest?: string; browser_download_url: string }[];
	};
	const asset = metadata.assets.find((item) => item.name === bunArchive);
	if (!asset) throw new Error("Bun release is missing the Mac binary.");
	const bun = await download(asset.browser_download_url);
	if (
		asset.digest !== `sha256:${createHash("sha256").update(bun).digest("hex")}`
	)
		throw new Error("Bun download failed its checksum.");
	writeFileSync(join(work, bunArchive), bun);
	run("/usr/bin/unzip", ["-q", bunArchive]);
	cpSync(join(work, bunName, "bun"), join(bin, "bun"));
	symlinkSync("bun", join(bin, "bunx"));
	writeFileSync(
		join(bin, "bun.LICENSE"),
		await download(
			`https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`,
		),
	);

	const selectedPackages = [
		"tedix",
		"api",
		"mcp",
		"os",
		"workspace-do",
		"tedi-runtime",
		"mcp-ui",
		"db",
	];
	run(
		process.execPath,
		[
			"install",
			"--frozen-lockfile",
			"--ignore-scripts",
			"--os=darwin",
			`--cpu=${arch}`,
			...selectedPackages.flatMap((name) => [
				"--filter",
				name === "tedix" ? name : `@tedix/${name}`,
			]),
		],
		runtime,
	);
	mkdirSync(output, { recursive: true });
	const archive = join(output, "local-workspace.tar.gz");
	const partial = `${archive}.partial`;
	try {
		run("/usr/bin/tar", ["-czf", partial, "-C", runtime, "."]);
		renameSync(partial, archive);
	} finally {
		rmSync(partial, { force: true });
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
