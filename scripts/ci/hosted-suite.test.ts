import { describe, expect, test } from "bun:test";
import { deployedSha, greenBase, hostedObservation } from "./hosted-suite.mjs";

const [a, b, c, d] = ["a", "b", "c", "d"].map((x) => x.repeat(40));
// Linear history a <- b <- c; d is off main.
const order = [a, b, c];
const isAncestor = (x: string, y: string) =>
	order.includes(x) && order.includes(y) && order.indexOf(x) < order.indexOf(y);

describe("deployed commit", () => {
	test("is the newest report when services were deployed at different commits", () => {
		expect(deployedSha([b, c, a], isAncestor)).toBe(c);
	});
	test("is unknown when reports diverge, so nothing unconfirmed is tested", () => {
		expect(deployedSha([c, d], isAncestor)).toBeNull();
		expect(deployedSha([c, "unknown"], isAncestor)).toBeNull();
	});
});

describe("post-deploy range", () => {
	const run = (id: number, sha: string, conclusion = "success") => ({
		id,
		status: "completed",
		conclusion,
		display_title: `Post-deploy tests @ ${sha}`,
	});
	test("starts after the last passing run, so a failed range is tested again", () => {
		expect(
			greenBase([run(3, b, "failure"), run(2, a)], c, { isAncestor }),
		).toBe(a);
	});
	test("ignores its own run and passing runs of other commits", () => {
		expect(
			greenBase([run(9, c), run(8, d)], c, { runId: 9, isAncestor }),
		).toBeNull();
	});
});

describe("hosted observation", () => {
	const base = {
		path: ".github/workflows/hosted-suite.yml",
		head_branch: "main",
		head_repository: { full_name: "example/product" },
		head_sha: d,
		html_url: "https://github.com/example/product/actions/runs/1",
	};
	const failedJob = {
		name: "Workspace apps/api",
		conclusion: "failure",
		html_url: "https://x/1",
	};
	test("reports the tested commit, not main's tip, on separate surfaces", () => {
		const deployed = hostedObservation({
			projectId: "p",
			repository: "example/product",
			run: {
				...base,
				conclusion: "failure",
				display_title: `Post-deploy tests @ ${b}`,
			},
			jobs: [failedJob],
		});
		expect(deployed).toMatchObject({
			sha: b,
			kind: "ci_red",
			surface: "post-deploy",
		});
		const nightly = hostedObservation({
			projectId: "p",
			repository: "example/product",
			run: {
				...base,
				conclusion: "success",
				display_title: `Nightly full suite @ ${c}`,
			},
			jobs: [],
		});
		expect(nightly).toMatchObject({
			sha: c,
			kind: "ci_green",
			surface: "hosted-full",
		});
	});
});
