import { describe, expect, test } from "bun:test";
import {
	deployedSha,
	deployedRunSha,
	greenBase,
	hostedObservation,
	testedPostDeploySha,
	WATCH_TITLE,
} from "./hosted-suite.mjs";

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
	test("recognizes old and explanatory post-deploy titles", () => {
		expect(deployedRunSha({ display_title: `Post-deploy tests @ ${b}` })).toBe(
			b,
		);
		expect(
			deployedRunSha({
				display_title: `Post-deploy tests (skip if none affected) @ ${b}`,
			}),
		).toBe(b);
	});
	const run = (id: number, sha: string, conclusion = "success") => ({
		id,
		status: "completed",
		conclusion,
		display_title: `Post-deploy tests @ ${sha}`,
	});
	test("starts after the last passing run, so a failed range is tested again", async () => {
		expect(
			await greenBase([run(3, b, "failure"), run(2, a)], c, { isAncestor }),
		).toBe(a);
	});
	test("ignores its own run and passing runs of other commits", async () => {
		expect(
			await greenBase([run(9, c), run(8, d)], c, { runId: 9, isAncestor }),
		).toBeNull();
	});
	test("does not use a green no-test run as a baseline", async () => {
		const jobs = {
			3: [{ steps: [{ name: "Test suite", conclusion: "skipped" }] }],
			2: [{ steps: [{ name: "Test suite", conclusion: "success" }] }],
		};
		expect(
			await greenBase([run(3, b), run(2, a)], c, {
				isAncestor,
				testedOf: (candidate: { id: number; display_title: string }) =>
					testedPostDeploySha(candidate, jobs[candidate.id as 2 | 3]),
			}),
		).toBe(a);
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
			jobs: [
				{
					name: "Workspace apps/api",
					steps: [{ name: "Test suite", conclusion: "success" }],
				},
			],
		});
		expect(nightly).toMatchObject({
			sha: c,
			kind: "ci_green",
			surface: "hosted-full",
		});
	});
	test("a titled success with skipped tests cannot clear a failure", () => {
		expect(
			hostedObservation({
				projectId: "p",
				repository: "example/product",
				run: {
					...base,
					conclusion: "success",
					display_title: `Post-deploy tests @ ${b}`,
				},
				jobs: [
					{
						name: "Workspace apps/api",
						steps: [{ name: "Test suite", conclusion: "skipped" }],
					},
				],
			}),
		).toBeNull();
	});
	test("reports plan failures without test steps", () => {
		expect(
			hostedObservation({
				projectId: "p",
				repository: "example/product",
				run: { ...base, conclusion: "failure", display_title: WATCH_TITLE },
				jobs: [{ name: "plan", conclusion: "failure" }],
			}),
		).toMatchObject({ sha: d, kind: "ci_red", surface: "post-deploy" });
	});
	test("reads a watch run's tested commit from its aggregate, and skips an idle one", () => {
		const watch = { ...base, display_title: WATCH_TITLE };
		expect(
			hostedObservation({
				projectId: "p",
				repository: "example/product",
				run: { ...watch, conclusion: "failure" },
				jobs: [
					failedJob,
					{ name: `Hosted suite @ ${b}`, conclusion: "failure" },
				],
			}),
		).toMatchObject({ sha: b, kind: "ci_red", surface: "post-deploy" });
		expect(
			hostedObservation({
				projectId: "p",
				repository: "example/product",
				run: { ...watch, conclusion: "success" },
				jobs: [{ name: "Hosted suite @ ", conclusion: "skipped" }],
			}),
		).toBeNull();
	});
});
