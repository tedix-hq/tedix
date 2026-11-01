import { afterEach, beforeEach, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Catch default-directory writes without ever exposing the user's journal. */
export function isolateRenewalTests(): void {
	let directory: string;
	let previousHome: string | undefined;
	let previousConfig: string | undefined;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "tedix-renewal-test-"));
		previousHome = process.env.HOME;
		previousConfig = process.env.TEDIX_CONFIG_DIR;
		process.env.HOME = join(directory, "home");
		process.env.TEDIX_CONFIG_DIR = join(directory, "config");
		mkdirSync(process.env.HOME);
		mkdirSync(join(process.env.HOME, ".tedix"));
		mkdirSync(process.env.TEDIX_CONFIG_DIR);
	});
	afterEach(() => {
		try {
			expect(
				existsSync(join(directory, "home", ".tedix", "renewals.log")),
			).toBe(false);
			expect(
				existsSync(join(directory, "home", ".tedix", "renewals.log.1")),
			).toBe(false);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousConfig === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previousConfig;
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
