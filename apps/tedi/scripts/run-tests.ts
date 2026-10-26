/**
 * `test:run` for this workspace: the Node unit suite, then the workerd suite.
 *
 * `bun run test:run <file>` used to append the file only to the second half
 * (`test:unit && test:workerd <file>`), so a narrowed run still ran every unit
 * test. Named test files now go to the half that owns them — `*.workerd.test.ts`
 * to the workerd config, the rest to the unit config — and a half with no
 * named file is skipped. Other arguments (`-t <name>`, `--reporter`) reach
 * both halves. With no file named, both halves run in full, as before.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const workspace = join(import.meta.dirname, "..");
const vp = join(workspace, "..", "..", "node_modules", ".bin", "vp");

export function splitTestArgs(args: readonly string[]): {
	unit: string[] | null;
	workerd: string[] | null;
} {
	const isFile = (arg: string) => /\.test\.tsx?$/.test(arg);
	const files = args.filter(isFile);
	const rest = args.filter((arg) => !isFile(arg));
	const workerdFiles = files.filter((file) =>
		file.endsWith(".workerd.test.ts"),
	);
	const unitFiles = files.filter((file) => !file.endsWith(".workerd.test.ts"));
	const all = files.length === 0;
	return {
		unit: all || unitFiles.length ? [...rest, ...unitFiles] : null,
		workerd:
			all || workerdFiles.length
				? ["--config", "vitest.workerd.config.ts", ...rest, ...workerdFiles]
				: null,
	};
}

if (import.meta.main) {
	const { unit, workerd } = splitTestArgs(process.argv.slice(2));
	for (const args of [unit, workerd]) {
		if (!args) continue;
		const result = spawnSync(vp, ["test", "run", ...args], {
			cwd: workspace,
			stdio: "inherit",
		});
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
}
