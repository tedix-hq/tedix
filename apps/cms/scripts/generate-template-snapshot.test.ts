import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { collectTemplateEntries } from "./generate-template-snapshot";

describe("required snapshot inputs", () => {
	it("fails rather than emitting a partial snapshot when locked files are missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "cms-snapshot-"));
		try {
			await mkdir(join(root, "templates/tedix"), { recursive: true });
			await expect(collectTemplateEntries("tedix", root)).rejects.toThrow(
				/missing required locked files:[\s\S]*bun.lock/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
