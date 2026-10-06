import { describe, expect, it } from "vite-plus/test";
import {
	formatBrowserQaGateFailure,
	type GeneratedWidgetQaArtifact,
	type GeneratedWidgetQaRun,
	validateGeneratedWidgetBrowserQaRun,
	validateGeneratedWidgetProgressStatus,
} from "./generated-widget-qa-gate";

const artifact: GeneratedWidgetQaArtifact = {
	id: "artifact-1",
	organizationId: "org-1",
	appId: "app-1",
	appSlug: "demo",
	toolId: "list_items",
	toolName: "list_items",
	status: "qa_passed",
};

const passingRun: GeneratedWidgetQaRun = {
	id: "run-1",
	organizationId: "org-1",
	appId: "app-1",
	appSlug: "demo",
	toolName: "list_items",
	mode: "static",
	passed: true,
	previewUrl: "https://mcp-ui.tedix.dev/demo/r/preview",
	screenshots: [
		{
			label: "full-page",
			url: "https://assets.example/widget.png",
			mimeType: "image/png",
		},
	],
	domSummary: {
		qaEvidence: {
			capturedAt: "2026-05-17T10:00:00.000Z",
			screenshot: {
				label: "full-page",
				url: "https://assets.example/widget.png",
				mimeType: "image/png",
			},
			console: {
				captured: true,
				errorCount: 0,
				errors: [],
				messages: [],
			},
			network: {
				captured: true,
				errorCount: 0,
				failureCount: 0,
				responseErrorCount: 0,
				failures: [],
				responseErrors: [],
			},
			layout: {
				viewport: { width: 420, height: 800 },
				document: { width: 420, height: 900 },
				widget: { width: 420, height: 760, x: 0, y: 0 },
			},
		},
	},
	visualDiff: {
		status: "skipped",
		passed: null,
	},
};

describe("generated widget Browser QA gate", () => {
	it("accepts a matching passed Browser QA run with screenshot, console, and network evidence", () => {
		const result = validateGeneratedWidgetBrowserQaRun(artifact, passingRun);

		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		expect(result.evidence).toMatchObject({
			widgetTestRunId: "run-1",
			screenshotUrl: "https://assets.example/widget.png",
			consoleCaptured: true,
			consoleErrorCount: 0,
			networkCaptured: true,
			networkErrorCount: 0,
			layoutCaptured: true,
		});
	});

	it("rejects status-only or legacy runs without structured Browser QA evidence", () => {
		const result = validateGeneratedWidgetBrowserQaRun(artifact, {
			...passingRun,
			domSummary: { errors: [] },
		});

		expect(result.ok).toBe(false);
		expect(formatBrowserQaGateFailure(result)).toContain(
			"missing structured screenshot evidence",
		);
		expect(result.failures).toContain(
			"QA run is missing console capture evidence",
		);
		expect(result.failures).toContain(
			"QA run is missing network capture evidence",
		);
	});

	it("rejects cross-app QA evidence even when the run passed", () => {
		const result = validateGeneratedWidgetBrowserQaRun(artifact, {
			...passingRun,
			appId: "other-app",
			appSlug: "other",
		});

		expect(result.ok).toBe(false);
		expect(result.failures).toContain("QA run belongs to a different app id");
		expect(result.failures).toContain("QA run belongs to a different app slug");
	});

	it("blocks progress writes from bypassing Browser QA attach or publish", () => {
		expect(validateGeneratedWidgetProgressStatus("qa_running")).toBeNull();
		expect(validateGeneratedWidgetProgressStatus("qa_passed")).toContain(
			"can only be set by Browser QA attach/publish operations",
		);
		expect(validateGeneratedWidgetProgressStatus("published")).toContain(
			"can only be set by Browser QA attach/publish operations",
		);
	});
});
