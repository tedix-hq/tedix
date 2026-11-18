import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function createScaffoldDatabase(slug: string) {
	const directory = await mkdtemp(join(tmpdir(), `tedix-scaffold-${slug}-`));
	const template = new URL(`../templates/${slug}/`, import.meta.url);
	const cli = fileURLToPath(
		new URL("node_modules/emdash/dist/cli/index.mjs", template),
	);
	const database = join(directory, "site.db");
	const cleanup = () => rm(directory, { recursive: true, force: true });
	const run = (...args: string[]) =>
		exec("node", [cli, ...args], {
			cwd: directory,
			timeout: 30_000,
		});
	const apply = (seed: string) =>
		run("seed", seed, "--database", database, "--skip-media");
	try {
		await apply(fileURLToPath(new URL("seed/seed.json", template)));
		return { directory, database, run, apply, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
