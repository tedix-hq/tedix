/**
 * Generated widget Browser QA gate.
 *
 * Publication must be backed by a real widget_test_runs row produced by the
 * Browser QA runner. Artifact status alone is not evidence.
 */

import { isRecord } from "@tedix/api-contract/utils/is-record";

const PUBLISH_BLOCKED_STATUSES = new Set(["qa_passed", "published"]);

type JsonRecord = Record<string, unknown>;

export interface GeneratedWidgetQaArtifact {
	id: string;
	organizationId: string;
	appId: string;
	appSlug: string;
	toolId?: string | null;
	toolName?: string | null;
	status?: string | null;
}

export interface GeneratedWidgetQaRun {
	id: string;
	organizationId?: string | null;
	appId?: string | null;
	appSlug: string;
	toolName: string;
	mode: string;
	passed: boolean;
	screenshots?: unknown;
	domSummary?: unknown;
	visualDiff?: unknown;
	previewUrl?: string | null;
	error?: string | null;
	stepCount?: number | null;
	stepsPassedCount?: number | null;
	durationMs?: number | null;
	toolResult?: unknown;
	widgetAnalysis?: unknown;
	createdAt?: string | null;
}

export interface BrowserQaGateResult {
	ok: boolean;
	failures: string[];
	evidence: {
		widgetTestRunId: string;
		mode: string;
		screenshotUrl: string | null;
		screenshotCount: number;
		consoleCaptured: boolean;
		consoleErrorCount: number | null;
		networkCaptured: boolean;
		networkErrorCount: number | null;
		layoutCaptured: boolean;
		visualDiffStatus: string | null;
		visualDiffPassed: boolean | null;
	};
}

export function validateGeneratedWidgetProgressStatus(
	status: string,
): string | null {
	if (!PUBLISH_BLOCKED_STATUSES.has(status)) return null;
	return `Generated widget artifact status "${status}" can only be set by Browser QA attach/publish operations`;
}

export function formatBrowserQaGateFailure(
	result: BrowserQaGateResult,
): string {
	return `Generated widget artifact requires a passing Browser QA run with screenshot, console, and network evidence before publishing: ${result.failures.join("; ")}`;
}

export function validateGeneratedWidgetBrowserQaRun(
	artifact: GeneratedWidgetQaArtifact,
	run: GeneratedWidgetQaRun,
): BrowserQaGateResult {
	const failures: string[] = [];
	const screenshots = normalizeScreenshotEvidence(run.screenshots);
	const evidence = normalizeBrowserQaEvidence(run.domSummary);
	const visualDiff = normalizeVisualDiff(run.visualDiff);

	if (run.organizationId !== artifact.organizationId) {
		failures.push("QA run belongs to a different organization");
	}
	if (run.appId !== artifact.appId) {
		failures.push("QA run belongs to a different app id");
	}
	if (run.appSlug !== artifact.appSlug) {
		failures.push("QA run belongs to a different app slug");
	}

	const expectedToolNames = new Set(
		[artifact.toolId, artifact.toolName].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		),
	);
	if (expectedToolNames.size > 0 && !expectedToolNames.has(run.toolName)) {
		failures.push("QA run belongs to a different tool");
	}

	if (run.mode !== "static" && run.mode !== "interactive") {
		failures.push("QA run was not produced by the Browser QA runner");
	}
	if (run.passed !== true) {
		failures.push("QA run did not pass");
	}
	if (run.error) {
		failures.push(`QA run has an execution error: ${run.error}`);
	}
	if (!run.previewUrl) {
		failures.push("QA run is missing preview URL evidence");
	}

	if (screenshots.urls.length === 0) {
		failures.push("QA run is missing persisted screenshot evidence");
	}
	if (!evidence.screenshotUrl) {
		failures.push("QA run is missing structured screenshot evidence");
	} else if (!screenshots.urls.includes(evidence.screenshotUrl)) {
		failures.push("Structured screenshot evidence is not persisted on the run");
	}

	if (!evidence.consoleCaptured) {
		failures.push("QA run is missing console capture evidence");
	} else if ((evidence.consoleErrorCount ?? 1) > 0) {
		failures.push(
			`QA run has ${evidence.consoleErrorCount ?? "unknown"} browser console error(s)`,
		);
	}

	if (!evidence.networkCaptured) {
		failures.push("QA run is missing network capture evidence");
	} else if ((evidence.networkErrorCount ?? 1) > 0) {
		failures.push(
			`QA run has ${evidence.networkErrorCount ?? "unknown"} network error(s)`,
		);
	}

	if (!evidence.layoutCaptured) {
		failures.push("QA run is missing layout dimension evidence");
	}

	if (visualDiff.status === "compared" && visualDiff.passed === false) {
		failures.push("QA visual diff failed against the latest baseline");
	}
	if (visualDiff.status === "failed") {
		failures.push("QA visual diff could not be evaluated");
	}

	return {
		ok: failures.length === 0,
		failures,
		evidence: {
			widgetTestRunId: run.id,
			mode: run.mode,
			screenshotUrl: evidence.screenshotUrl ?? screenshots.urls[0] ?? null,
			screenshotCount: screenshots.urls.length,
			consoleCaptured: evidence.consoleCaptured,
			consoleErrorCount: evidence.consoleErrorCount,
			networkCaptured: evidence.networkCaptured,
			networkErrorCount: evidence.networkErrorCount,
			layoutCaptured: evidence.layoutCaptured,
			visualDiffStatus: visualDiff.status,
			visualDiffPassed: visualDiff.passed,
		},
	};
}

export function buildGeneratedWidgetQaSummary(
	run: GeneratedWidgetQaRun,
	gate: BrowserQaGateResult,
): JsonRecord {
	return {
		widgetTestRunId: run.id,
		mode: run.mode,
		passed: run.passed,
		stepCount: run.stepCount ?? null,
		stepsPassedCount: run.stepsPassedCount ?? null,
		durationMs: run.durationMs ?? null,
		error: run.error ?? null,
		gate: {
			passed: gate.ok,
			failures: gate.failures,
			evidence: gate.evidence,
		},
		toolResult: run.toolResult ?? null,
		domSummary: run.domSummary ?? null,
		widgetAnalysis: run.widgetAnalysis ?? null,
		visualDiff: run.visualDiff ?? null,
		screenshots: run.screenshots ?? null,
	};
}

function normalizeScreenshotEvidence(value: unknown): { urls: string[] } {
	if (!Array.isArray(value)) return { urls: [] };
	const urls: string[] = [];
	for (const screenshot of value) {
		if (!isRecord(screenshot)) continue;
		if (typeof screenshot.url === "string" && screenshot.url.length > 0) {
			urls.push(screenshot.url);
		}
	}
	return { urls };
}

function normalizeBrowserQaEvidence(value: unknown): {
	screenshotUrl: string | null;
	consoleCaptured: boolean;
	consoleErrorCount: number | null;
	networkCaptured: boolean;
	networkErrorCount: number | null;
	layoutCaptured: boolean;
} {
	const domSummary = isRecord(value) ? value : null;
	const qaEvidence = isRecord(domSummary?.qaEvidence)
		? domSummary.qaEvidence
		: null;
	const screenshot = isRecord(qaEvidence?.screenshot)
		? qaEvidence.screenshot
		: null;
	const consoleEvidence = isRecord(qaEvidence?.console)
		? qaEvidence.console
		: null;
	const networkEvidence = isRecord(qaEvidence?.network)
		? qaEvidence.network
		: null;
	const layoutEvidence = isRecord(qaEvidence?.layout)
		? qaEvidence.layout
		: null;

	const networkFailureCount = readNumber(networkEvidence, "failureCount");
	const networkResponseErrorCount = readNumber(
		networkEvidence,
		"responseErrorCount",
	);
	const explicitNetworkErrorCount = readNumber(networkEvidence, "errorCount");
	const derivedNetworkErrorCount =
		networkFailureCount == null && networkResponseErrorCount == null
			? null
			: (networkFailureCount ?? 0) + (networkResponseErrorCount ?? 0);

	return {
		screenshotUrl:
			typeof screenshot?.url === "string" && screenshot.url.length > 0
				? screenshot.url
				: null,
		consoleCaptured: consoleEvidence?.captured === true,
		consoleErrorCount: readNumber(consoleEvidence, "errorCount"),
		networkCaptured: networkEvidence?.captured === true,
		networkErrorCount: explicitNetworkErrorCount ?? derivedNetworkErrorCount,
		layoutCaptured: hasPositiveDimension(layoutEvidence, "viewport"),
	};
}

function normalizeVisualDiff(value: unknown): {
	status: string | null;
	passed: boolean | null;
} {
	if (!isRecord(value)) return { status: null, passed: null };
	return {
		status: typeof value.status === "string" ? value.status : null,
		passed: typeof value.passed === "boolean" ? value.passed : null,
	};
}

function hasPositiveDimension(value: unknown, key: string): boolean {
	if (!isRecord(value)) return false;
	const nested = value[key];
	if (!isRecord(nested)) return false;
	const width = readNumber(nested, "width");
	const height = readNumber(nested, "height");
	return width != null && width > 0 && height != null && height > 0;
}

function readNumber(value: unknown, key: string): number | null {
	if (!isRecord(value)) return null;
	const raw = value[key];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}
