import { describe, expect, it } from "vite-plus/test";
import {
	createOsErrorReporter,
	MAX_REPORTS_PER_WINDOW,
	REPORT_WINDOW_MS,
} from "./browser-reporter";
import type { OsClientErrorReportV1 } from "./report";

function harness(pageHref: () => string = () => "https://acme.os.tedix.dev/") {
	const sent: OsClientErrorReportV1[] = [];
	let clock = 1_000;
	const reporter = createOsErrorReporter({
		sessionId: "session-1",
		transport: (report) => {
			sent.push(report);
		},
		now: () => clock,
		pageHref,
	});
	return {
		sent,
		reporter,
		advance(ms: number) {
			clock += ms;
		},
	};
}

function throwsAt(frame: string): Error {
	const error = new TypeError("x is not a function");
	error.stack = `TypeError: x is not a function\n    at ${frame}`;
	return error;
}

describe("createOsErrorReporter", () => {
	it("sends a bounded report carrying the normalized page location", () => {
		const { reporter, sent } = harness(
			() => "https://acme.os.tedix.dev/outputs/9?q=1#share=cap_live_abc123",
		);

		reporter.reportIssue("os.route-boundary", throwsAt("render (app.js:1:1)"), {
			handled: false,
			captureMechanism: "react",
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			schemaVersion: 1,
			failureSite: "os.route-boundary",
			severity: "error",
			handled: false,
			captureMechanism: "react",
			sessionId: "session-1",
			pageLocation: "https://acme.os.tedix.dev/outputs/9",
		});
		expect(sent[0]?.exception?.type).toBe("TypeError");
	});

	it("deduplicates the same fault within the window", () => {
		const { reporter, sent } = harness();

		for (let attempt = 0; attempt < 5; attempt += 1) {
			reporter.reportIssue(
				"os.route-boundary",
				throwsAt("render (app.js:1:1)"),
			);
		}

		expect(sent).toHaveLength(1);
	});

	it("treats a different first stack frame as a different fault", () => {
		const { reporter, sent } = harness();

		reporter.reportIssue("os.route-boundary", throwsAt("render (app.js:1:1)"));
		reporter.reportIssue("os.route-boundary", throwsAt("mount (app.js:9:9)"));

		expect(sent).toHaveLength(2);
	});

	it("excludes the route from the fingerprint so a navigation loop cannot exhaust the cap", () => {
		let route = 0;
		const { reporter, sent } = harness(
			() => `https://acme.os.tedix.dev/w/${route}`,
		);

		for (route = 0; route < 50; route += 1) {
			reporter.reportIssue(
				"os.route-boundary",
				throwsAt("render (app.js:1:1)"),
			);
		}

		expect(sent).toHaveLength(1);
	});

	it("caps distinct faults per window and resets on the next window", () => {
		const { reporter, sent, advance } = harness();

		for (let index = 0; index < MAX_REPORTS_PER_WINDOW + 20; index += 1) {
			reporter.reportIssue(`os.site-${index}`, throwsAt("render (app.js:1:1)"));
		}
		expect(sent).toHaveLength(MAX_REPORTS_PER_WINDOW);

		advance(REPORT_WINDOW_MS);
		reporter.reportIssue("os.site-after", throwsAt("render (app.js:1:1)"));
		expect(sent).toHaveLength(MAX_REPORTS_PER_WINDOW + 1);
	});

	it("does not read the page location for a suppressed report", () => {
		let reads = 0;
		const { reporter } = harness(() => {
			reads += 1;
			return "https://acme.os.tedix.dev/";
		});

		reporter.reportIssue("os.route-boundary", throwsAt("render (app.js:1:1)"));
		reporter.reportIssue("os.route-boundary", throwsAt("render (app.js:1:1)"));
		reporter.reportIssue("os.route-boundary", throwsAt("render (app.js:1:1)"));

		expect(reads).toBe(1);
	});

	it("omits an unreportable page location instead of discarding the report", () => {
		const { reporter, sent } = harness(() => {
			throw new Error("location is unavailable");
		});

		reporter.reportIssue("os.route-boundary", throwsAt("render (app.js:1:1)"));

		expect(sent).toHaveLength(1);
		expect(sent[0]?.pageLocation).toBeUndefined();
	});

	it("never propagates a transport failure to the caller", () => {
		const reporter = createOsErrorReporter({
			transport: () => Promise.reject(new Error("network down")),
			pageHref: () => "https://acme.os.tedix.dev/",
		});

		expect(() =>
			reporter.reportIssue("os.site", new Error("boom")),
		).not.toThrow();
	});
});
