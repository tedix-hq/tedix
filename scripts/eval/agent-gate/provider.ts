import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default class LessonProvider {
	id() {
		return "tedix-local-lesson-selector";
	}
	async callApi(prompt: string) {
		const result = spawnSync(
			"bun",
			[fileURLToPath(new URL("adapter.ts", import.meta.url)), prompt],
			{ encoding: "utf8", timeout: 10000 },
		);
		if (result.error || result.status !== 0)
			return { error: result.error?.message ?? result.stderr };
		return { output: result.stdout.trim() };
	}
}
