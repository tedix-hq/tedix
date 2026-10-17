import { describe, expect, it } from "vite-plus/test";
import {
	briefRepository,
	lessonMatches,
	recallLessons,
	renderRecall,
	incidentFingerprint,
} from "./situational-recall";
describe("situational recall", () => {
	it("matches glob paths in edits and briefs, including a zero-directory globstar", () => {
		const triggers = {
			pathGlobs: ["apps/*/worker.jsonc", "**/cloud.config.ts"],
		};
		expect(
			lessonMatches(triggers, { paths: ["apps/example/worker.jsonc"] }),
		).toBe(true);
		expect(
			lessonMatches(triggers, {
				text: "Update apps/example/worker.jsonc today",
			}),
		).toBe(true);
		expect(lessonMatches(triggers, { paths: ["cloud.config.ts"] })).toBe(true);
		expect(
			lessonMatches(
				{ pathGlobs: ["apps/*/Example.ts"] },
				{ text: "Edit apps/sample/Example.ts" },
			),
		).toBe(true);
		expect(lessonMatches(triggers, { text: "Update cloud.config.ts" })).toBe(
			true,
		);
		expect(lessonMatches(triggers, { paths: ["apps/a/b/worker.jsonc"] })).toBe(
			false,
		);
		expect(
			lessonMatches({ pathGlobs: ["file[1].ts"] }, { paths: ["file1.ts"] }),
		).toBe(false);
	});
	it("combines tenant/repo constraints with alternative action triggers", () => {
		const t = {
			repos: ["github.com/example/product"],
			organizations: ["example-org"],
			commands: ["tool login"],
			keywords: ["worker binding"],
		};
		expect(
			lessonMatches(t, {
				repo: "git@github.com:example/product.git",
				organization: "example-org",
				command: "tool login --help",
			}),
		).toBe(true);
		expect(
			lessonMatches(t, {
				repo: "github.com/example/product",
				organization: "other",
				command: "tool login",
			}),
		).toBe(false);
		expect(
			lessonMatches({ commands: ["git push"] }, { command: "git pushy" }),
		).toBe(false);
		expect(
			lessonMatches(
				{ commands: ["git push"] },
				{ command: "cd repo && git   push origin main" },
			),
		).toBe(true);
		expect(lessonMatches(undefined, { text: "anything" })).toBe(false);
	});
	it("renders matching lessons with a soft reminder and normalizes incidents", () => {
		const result = recallLessons(
			[
				{
					id: "12345678-example",
					text: "Check the linked config.",
					triggers: { keywords: ["config"] },
				},
			],
			{ text: "Edit config" },
		);
		expect(renderRecall(result)).toContain("Confirm you applied: 12345678");
		expect(renderRecall([])).toBe("");
		expect(incidentFingerprint("Run 12345678: failed eb11cf72")).toBe(
			incidentFingerprint("run 98765432: FAILED aaaa1234"),
		);
	});
});

it("reads an explicit repository URL or path from a lane brief", () => {
	expect(briefRepository("Repo /work/example-product; update config")).toBe(
		"example-product",
	);
	expect(
		briefRepository("Repository: https://code.example.org/team/product.git"),
	).toBe("code.example.org/team/product");
	expect(briefRepository("Repo git@code.example.org:team/product.git")).toBe(
		"code.example.org/team/product",
	);
	expect(briefRepository("Edit apps/example/worker.jsonc")).toBeUndefined();
});
