import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { RunStatusChip, runStatusTone } from "./activity-runs";

describe("runStatusTone", () => {
	it("maps run statuses to chip tones", () => {
		expect(runStatusTone("queued")).toBe("active");
		expect(runStatusTone("running")).toBe("active");
		expect(runStatusTone("paused")).toBe("active");
		expect(runStatusTone("failed")).toBe("blocked");
		expect(runStatusTone("completed")).toBe("done");
		expect(runStatusTone("canceled")).toBe("neutral");
	});
});

describe("RunStatusChip", () => {
	it("renders the status as a sentence-cased Kumo badge with its tone", () => {
		const html = renderToStaticMarkup(<RunStatusChip status="failed" />);
		expect(html).toContain('data-tone="blocked"');
		expect(html).toContain('data-status="failed"');
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain("Failed");
	});
});
