import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	EMBED_BUILD_SHA,
	EMBED_RELEASED_AT,
	EMBED_SDK_VERSION,
	MINIMUM_BOOTSTRAP_VERSION,
	versionEmbedBundle,
} from "./version-embed";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("versionEmbedBundle", () => {
	it("emits one deterministic content-addressed bundle and manifest", async () => {
		const publicDir = await mkdtemp(join(tmpdir(), "tedix-widget-"));
		temporaryDirectories.push(publicDir);
		const bundle = "console.log('widget');\n";
		const loader = 'const runtime = "__TEDIX_RUNTIME_PATH__";\n';
		const sha256 = createHash("sha256").update(bundle).digest("hex");
		const versionedLoader = loader.replace(
			"__TEDIX_RUNTIME_PATH__",
			`/v1/embed.${sha256}.js`,
		);
		const loaderSha256 = createHash("sha256")
			.update(versionedLoader)
			.digest("hex");
		await writeFile(join(publicDir, "embed.js"), bundle);
		await writeFile(join(publicDir, "loader.js"), loader);

		const first = await versionEmbedBundle(publicDir);
		await writeFile(join(publicDir, "v1", "embed.stale.js"), "stale");
		const second = await versionEmbedBundle(publicDir);

		expect(first).toEqual(second);
		expect(first).toEqual({
			version: 1,
			sdkVersion: EMBED_SDK_VERSION,
			buildSha: EMBED_BUILD_SHA,
			releasedAt: EMBED_RELEASED_AT,
			minimumBootstrapVersion: MINIMUM_BOOTSTRAP_VERSION,
			path: `/v1/embed.${sha256}.js`,
			sha256,
			integrity: `sha256-${createHash("sha256").update(bundle).digest("base64")}`,
			loaderPath: `/v1/loader.${loaderSha256}.js`,
			loaderSha256,
			loaderIntegrity: `sha256-${createHash("sha256").update(versionedLoader).digest("base64")}`,
		});
		expect((await readdir(join(publicDir, "v1"))).sort()).toEqual(
			[
				`embed.${sha256}.js`,
				"embed.js",
				`loader.${loaderSha256}.js`,
				"loader.js",
				"manifest.json",
			].sort(),
		);
		expect(await readFile(join(publicDir, "v1", "embed.js"), "utf8")).toBe(
			bundle,
		);
		expect(await readFile(join(publicDir, "v1", "loader.js"), "utf8")).toBe(
			versionedLoader,
		);
		expect(await readFile(join(publicDir, "loader.js"), "utf8")).toBe(
			versionedLoader,
		);
		expect(
			JSON.parse(
				await readFile(join(publicDir, "v1", "manifest.json"), "utf8"),
			),
		).toEqual(first);
	});
});
