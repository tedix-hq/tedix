import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { evidenceDirVariable, specEvidenceName } from "./failure-evidence";

// Chromium's browser-level trace can collect renderer samples even when an
// actionability check stops responding. Keep it separate from Playwright's
// context trace, in the same directory retained only for failing specs.
export async function withInteractionProfile(
	browser: Pick<Browser, "startTracing" | "stopTracing">,
	label: string,
	interaction: () => Promise<void>,
) {
	const dir = process.env[evidenceDirVariable];
	if (!dir) return interaction();
	const path = join(dir, specEvidenceName(process.argv[1]), `${label}.json`);
	const unavailable = (error: unknown) => {
		console.error(`[profile] ${label} unavailable: ${error}`);
		try {
			writeFileSync(`${path}.unavailable.txt`, String(error));
		} catch {
			// Diagnostics must preserve the interaction's result.
		}
	};
	async function bounded<T>(operation: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("profile capture exceeded 2000ms")),
						2_000,
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	let started = false;
	try {
		mkdirSync(join(dir, specEvidenceName(process.argv[1])), {
			recursive: true,
		});
		await bounded(browser.startTracing(undefined, { path }));
		started = true;
	} catch (error) {
		unavailable(error);
	}
	try {
		await interaction();
	} finally {
		if (started) {
			try {
				await bounded(browser.stopTracing());
			} catch (error) {
				unavailable(error);
			}
		}
	}
}
