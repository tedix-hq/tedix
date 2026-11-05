import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
	configWithImageReference,
	dockerCopySources,
	imageInputTag,
	imageReference,
} from "./deploy-image";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("dockerCopySources", () => {
	it("lists every build-context path the image Dockerfile copies", async () => {
		const dockerfile = await readFile(join(appDir, "Dockerfile"), "utf8");
		const sources = dockerCopySources(dockerfile);
		expect(sources).toContain("template/astro.config.ts");
		expect(sources).toContain("template/public/");
		expect(sources.length).toBeGreaterThan(20);
	});

	it("ignores COPY lines staging from earlier image stages", () => {
		const dockerfile = [
			"FROM base AS tools",
			"FROM final",
			"COPY --from=tools /bin/shim /usr/local/bin/shim",
			"COPY app/ /srv/app/",
		].join("\n");
		expect(dockerCopySources(dockerfile)).toEqual(["app/"]);
	});
});

describe("imageInputTag", () => {
	it("is stable across file ordering and changes with any input", () => {
		const files = [
			{ path: "Dockerfile", contents: Buffer.from("FROM a\nCOPY x y\n") },
			{ path: "x", contents: Buffer.from("one") },
		];
		const tag = imageInputTag(files);
		expect(tag).toMatch(/^inputs-[0-9a-f]{16}$/);
		expect(imageInputTag([...files].reverse())).toBe(tag);
		const renamed = files.map(({ path, contents }) => ({
			path,
			contents: path === "x" ? Buffer.from("two") : contents,
		}));
		expect(imageInputTag(renamed)).not.toBe(tag);
	});
});

describe("configWithImageReference", () => {
	const reference = imageReference("a".repeat(32), "inputs-deadbeef");

	it("swaps the Sandbox dockerfile image for the pushed reference", async () => {
		const config = await readFile(join(appDir, "cloudflare.config.ts"), "utf8");
		const substituted = configWithImageReference(config, reference);
		expect(substituted).toContain(`sandbox: { reference: "${reference}" }`);
		expect(substituted).not.toContain('dockerfile: "./Dockerfile"');
	});

	it("rejects a config whose Sandbox image declaration moved", () => {
		expect(() => configWithImageReference("const x = 1;", reference)).toThrow(
			/exactly one Sandbox dockerfile image/,
		);
	});
});
