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

it.each([
	["letters", "a".repeat(50_000)],
	["long dotted segment", `${"a".repeat(25_000)}.${"a".repeat(24_998)}/`],
	["repeated a./", `${"a./".repeat(16_666)}a.`],
	["slashes", `${"/".repeat(49_999)}!`],
	["newlines", "\n".repeat(50_000)],
	["Repo spaces", `Repo${" ".repeat(49_996)}`],
])(
	"handles 50 KB adversarial recall input in under 50 ms (%s)",
	(_name, input) => {
		const start = performance.now();
		lessonMatches(
			{ pathGlobs: ["missing.ts"], repos: ["example/product"] },
			{
				repo: input,
				text: input,
			},
		);
		lessonMatches({ pathGlobs: ["missing.ts"] }, { text: input });
		briefRepository(input);
		expect(performance.now() - start).toBeLessThan(50);
	},
);

it.each([
	["Repo `team/my product`; next", "team/my product"],
	['Repository = "team/product".', "team/product"],
	["notes; repo\n /tmp/product///", "product"],
	["Repo:missing", undefined],
	["Repo :missing", ":missing"],
	["Repo : ", ":"],
	["Repo    ", undefined],
	["Repo 'unterminated", "unterminated"],
	["notes. repository team/product", "team/product"],
	["notes\n\n\t Repository : \n team/product", "team/product"],
	["notes; Repo:missing; repo team/product", "team/product"],
	["notes\n \t \n no header; Repo team/product", "team/product"],
	["not a repo team/product", undefined],
])("parses repository hint %s", (brief, expected) => {
	expect(briefRepository(brief)).toBe(expected);
});

it.each([
	"https://github.com/example/product.git",
	"git@github.com:example/product.git",
	"user@github.com/example/product.git",
	"GITHUB.COM/EXAMPLE/PRODUCT///",
])("normalizes repository %s", (repo) => {
	expect(
		lessonMatches(
			{ repos: ["github.com/example/product"], keywords: ["fix"] },
			{ repo, text: "fix" },
		),
	).toBe(true);
});

it.each([
	["Edit ./apps/example/worker.jsonc", "apps/example/worker.jsonc"],
	["Edit foo*.ts", "foo*.ts"],
	["Edit a.b*c/d", "a.b*c"],
	["Edit *.a./example", "example"],
	["Edit a..b.ts", "b.ts"],
	[
		`Edit ${"a".repeat(25_000)}!apps/example/worker.jsonc`,
		"apps/example/worker.jsonc",
	],
	["Edit aaaa*bbbb.ts", "aaaa*bbbb.ts"],
	["///! \n\tapps/example/worker.jsonc", "apps/example/worker.jsonc"],
	["///! \n\tfile.ts", "file.ts"],
])("extracts paths from %s", (text, path) => {
	expect(lessonMatches({ pathGlobs: [path] }, { text })).toBe(true);
});
