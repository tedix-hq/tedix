import { afterEach, describe, expect, it } from "vite-plus/test";
import { installOsErrorReporting, reportOsIssue } from "./install";
import type { OsClientErrorReportV1 } from "./report";

let teardown: (() => void) | null = null;

afterEach(() => {
	teardown?.();
	teardown = null;
});

function install() {
	const sent: OsClientErrorReportV1[] = [];
	teardown = installOsErrorReporting(window, (report) => {
		sent.push(report);
	});
	return sent;
}

describe("installOsErrorReporting", () => {
	it("captures an uncaught window error", () => {
		const sent = install();

		window.dispatchEvent(
			new ErrorEvent("error", { error: new TypeError("boom") }),
		);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			failureSite: "browser.window-error",
			captureMechanism: "window.error",
			handled: false,
		});
		expect(sent[0]?.exception?.type).toBe("TypeError");
	});

	it("ignores a resource-load error that carries no exception", () => {
		const sent = install();

		window.dispatchEvent(new ErrorEvent("error", { message: "script error" }));

		expect(sent).toHaveLength(0);
	});

	it("captures an unhandled rejection", () => {
		const sent = install();

		// happy-dom does not implement PromiseRejectionEvent, and the listener
		// only reads `reason`, so a plain Event carrying it is equivalent here.
		const event = Object.assign(new Event("unhandledrejection"), {
			reason: new RangeError("nope"),
		});
		window.dispatchEvent(event);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			failureSite: "browser.unhandled-rejection",
			captureMechanism: "unhandledrejection",
			handled: false,
		});
		expect(sent[0]?.exception?.type).toBe("RangeError");
	});

	it("routes an explicit report through the installed reporter", () => {
		const sent = install();

		reportOsIssue("os.route-boundary", new Error("render failed"), {
			handled: false,
			captureMechanism: "react",
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]?.captureMechanism).toBe("react");
	});

	it("stamps one stable session id per tab", () => {
		const first = install();
		reportOsIssue("os.a", new Error("a"));
		teardown?.();
		const second = install();
		reportOsIssue("os.b", new Error("b"));

		expect(first[0]?.sessionId).toBeTruthy();
		expect(second[0]?.sessionId).toBe(first[0]?.sessionId);
	});

	it("drops an explicit report when reporting is not installed", () => {
		expect(() => reportOsIssue("os.site", new Error("boom"))).not.toThrow();
	});

	it("removes its listeners on teardown", () => {
		const sent = install();
		teardown?.();
		teardown = null;

		window.dispatchEvent(
			new ErrorEvent("error", { error: new TypeError("boom") }),
		);

		expect(sent).toHaveLength(0);
	});
});
