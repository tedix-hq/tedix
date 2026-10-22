import { describe, expect, it } from "bun:test";
import { runContext, runOnboard, runReview } from "./learn-context";

for (const [command, run, typo, supported] of [
	["context", runContext, "--dry-ru", "--dry-run"],
	["review", runReview, "--accpet", "--accept"],
	["onboard", runOnboard, "--wiat", "--wait"],
] as const) {
	describe(`learn ${command} unknown options`, () => {
		it("suggests the nearest supported flag and command help", async () => {
			await expect(run([typo])).rejects.toThrow(
				`Unknown option ${typo} for "tedix learn ${command}"; did you mean ${supported}? See tedix learn ${command} --help`,
			);
		});

		it("provides command help without suggesting an unrelated flag", async () => {
			await expect(run(["--completely-unrelated"])).rejects.toThrow(
				`Unknown option --completely-unrelated for "tedix learn ${command}"; See tedix learn ${command} --help`,
			);
		});
	});
}
