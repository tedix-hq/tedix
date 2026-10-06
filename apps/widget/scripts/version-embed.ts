import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	WIDGET_MINIMUM_BOOTSTRAP_VERSION,
	WIDGET_SDK_VERSION,
} from "../src/sdk-contract";

export interface VersionedEmbedManifest {
	version: 1;
	sdkVersion: string;
	buildSha: string;
	releasedAt: string;
	minimumBootstrapVersion: string;
	path: string;
	sha256: string;
	integrity: string;
	loaderPath: string;
	loaderSha256: string;
	loaderIntegrity: string;
}

export const EMBED_SDK_VERSION = WIDGET_SDK_VERSION;
export const EMBED_BUILD_SHA =
	process.env.GIT_SHA || process.env.GITHUB_SHA || "development";
export const EMBED_RELEASED_AT = new Date().toISOString();
export const MINIMUM_BOOTSTRAP_VERSION = WIDGET_MINIMUM_BOOTSTRAP_VERSION;

export async function versionEmbedBundle(
	publicDir = join(import.meta.dir, "..", "public"),
): Promise<VersionedEmbedManifest> {
	const bundle = await readFile(join(publicDir, "embed.js"));
	const sha256 = createHash("sha256").update(bundle).digest("hex");
	const filename = `embed.${sha256}.js`;
	const loaderTemplate = await readFile(join(publicDir, "loader.js"), "utf8");
	const loader = Buffer.from(
		loaderTemplate.replace("__TEDIX_RUNTIME_PATH__", `/v1/${filename}`),
	);
	const loaderSha256 = createHash("sha256").update(loader).digest("hex");
	const versionDir = join(publicDir, "v1");
	const loaderFilename = `loader.${loaderSha256}.js`;
	const manifest: VersionedEmbedManifest = {
		version: 1,
		sdkVersion: EMBED_SDK_VERSION,
		buildSha: EMBED_BUILD_SHA,
		releasedAt: EMBED_RELEASED_AT,
		minimumBootstrapVersion: MINIMUM_BOOTSTRAP_VERSION,
		path: `/v1/${filename}`,
		sha256,
		integrity: `sha256-${createHash("sha256").update(bundle).digest("base64")}`,
		loaderPath: `/v1/${loaderFilename}`,
		loaderSha256,
		loaderIntegrity: `sha256-${createHash("sha256").update(loader).digest("base64")}`,
	};

	await rm(versionDir, { force: true, recursive: true });
	await mkdir(versionDir, { recursive: true });
	await Promise.all([
		writeFile(join(publicDir, "loader.js"), loader),
		writeFile(join(versionDir, "embed.js"), bundle),
		writeFile(join(versionDir, filename), bundle),
		writeFile(join(versionDir, "loader.js"), loader),
		writeFile(join(versionDir, loaderFilename), loader),
		writeFile(
			join(versionDir, "manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		),
	]);

	return manifest;
}

if (import.meta.main) {
	const manifest = await versionEmbedBundle();
	console.log(manifest.path);
}
