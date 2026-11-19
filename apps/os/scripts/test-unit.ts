import { join } from "node:path";
import { isPrimaryTestShard } from "../../../scripts/ci/test-shard";

const args = process.argv.slice(2);
const cwd = join(import.meta.dir, "..");

if (isPrimaryTestShard(args)) {
	for (const check of ["doc:check", "sheet:check", "slides:check"]) {
		const result = Bun.spawnSync(["bun", "run", check], {
			cwd,
			stdout: "inherit",
			stderr: "inherit",
		});
		if (result.exitCode !== 0) process.exit(result.exitCode);
	}
}

const result = Bun.spawnSync(["bun", "x", "vp", "test", "run", ...args], {
	cwd,
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(result.exitCode);
