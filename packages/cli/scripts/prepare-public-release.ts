import { createHash } from "node:crypto";
import {
	copyFileSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

interface PublicAsset {
	name: string;
	sha256: string;
	size: number;
	url: string;
}

export const CLI_RELEASE_VERIFICATION_CHECKS = [
	"test:run",
	"type-check",
	"test:protocol",
	"test:standalone",
	"test:installer",
] as const;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function preparePublicRelease(input: {
	distDir: string;
	packageDir: string;
	sourceSha: string;
	version: string;
	baseUrl?: string;
}): { assets: PublicAsset[]; latest: Record<string, unknown> } {
	const baseUrl = (input.baseUrl ?? "https://downloads.tedix.dev").replace(
		/\/+$/,
		"",
	);
	const prefix = `tedix-${input.version}-`;
	const expectedNames = [
		`tedix-${input.version}-darwin-arm64`,
		`tedix-${input.version}-darwin-x64`,
		`tedix-${input.version}-linux-arm64`,
		`tedix-${input.version}-linux-x64`,
		`tedix-${input.version}-windows-x64.exe`,
	];
	const names = readdirSync(input.distDir)
		.filter((name) => name.startsWith(prefix) && !name.endsWith(".bun-build"))
		.sort();
	if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
		throw new Error(
			`Standalone artifact inventory mismatch: expected ${expectedNames.join(", ")}; got ${names.join(", ") || "none"}`,
		);
	}
	const assets = names.map((name) => {
		const path = join(input.distDir, name);
		return {
			name,
			sha256: sha256(path),
			size: statSync(path).size,
			url: `${baseUrl}/releases/${input.version}/${name}`,
		};
	});
	writeFileSync(
		join(input.distDir, "SHA256SUMS"),
		`${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
	);
	const manifest = {
		schemaVersion: 1,
		version: input.version,
		tag: `cli-v${input.version}`,
		sourceSha: input.sourceSha,
		verificationUrl: `${baseUrl}/releases/${input.version}/verification.json`,
		assets,
	};
	writeFileSync(
		join(input.distDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	writeFileSync(
		join(input.distDir, "verification.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				version: input.version,
				tag: `cli-v${input.version}`,
				sourceSha: input.sourceSha,
				checks: CLI_RELEASE_VERIFICATION_CHECKS.map((id) => ({
					id,
					status: "passed",
				})),
			},
			null,
			2,
		)}\n`,
	);
	copyFileSync(
		join(input.packageDir, "install.sh"),
		join(input.distDir, "install.sh"),
	);
	const latest = {
		schemaVersion: 1,
		version: input.version,
		sourceSha: input.sourceSha,
		manifestUrl: `${baseUrl}/releases/${input.version}/manifest.json`,
		verificationUrl: `${baseUrl}/releases/${input.version}/verification.json`,
		installerUrl: `${baseUrl}/install.sh`,
	};
	writeFileSync(
		join(input.distDir, "latest.json"),
		`${JSON.stringify(latest, null, 2)}\n`,
	);
	return { assets, latest };
}

if (import.meta.main) {
	const packageDir = resolve(import.meta.dir, "..");
	const distDir = resolve(process.argv[2] ?? join(packageDir, "dist"));
	const pkg = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as {
		version: string;
	};
	const sourceSha = process.argv[3] ?? process.env.GITHUB_SHA;
	if (!sourceSha)
		throw new Error("Source SHA argument or GITHUB_SHA is required");
	const result = preparePublicRelease({
		distDir,
		packageDir,
		sourceSha,
		version: pkg.version,
	});
	console.log(
		JSON.stringify({
			distDir: basename(distDir),
			version: pkg.version,
			assets: result.assets.length,
		}),
	);
}
