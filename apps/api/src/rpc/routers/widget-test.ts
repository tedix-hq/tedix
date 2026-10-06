/**
 * Widget Test oRPC Router
 *
 * End-to-end widget testing via real MCP tool calls + browser rendering.
 *
 * Two modes (both use Firecrawl Browser Sandbox):
 * - `run`: Static screenshot via Firecrawl (Python Playwright)
 * - `runInteractive`: Multi-step interaction via Firecrawl (Python Playwright)
 *
 * Flow:
 * 1. Look up app + tool config in D1 (get layoutSpec)
 * 2. Connect to real MCP server via StreamableHTTP
 * 3. Call the tool with real args → get real structuredContent
 * 4. Build preview URL with layoutSpec + real data
 * 5. Render widget, execute interactions, capture screenshots
 * 6. Upload screenshots to R2, return analysis
 */

import { implement } from "@orpc/server";
import {
	type InteractionStep,
	widgetTestContract,
} from "@tedix/api-contract/contracts/widget-test";
import type {
	WidgetBrowserQaEvidence,
	WidgetVisualDiffOutput,
} from "@tedix/api-contract/schemas/widget-test-runs";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { getAppBySlugWithTools } from "@tedix/db/queries/app-records";
import {
	getLatestWidgetVisualDiffBaseline,
	insertWidgetTestRun,
} from "@tedix/db/queries/widget-test-runs";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	createFirecrawlBrowserClient,
	type FirecrawlBrowserClient,
} from "../../integrations/firecrawl/rest-client";
import {
	buildMcpHost,
	buildMcpUrl,
	callMcpTool as callSharedMcpTool,
	serviceBindingFetchFn,
} from "../../lib/mcp-client";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";
import {
	normalizeWidgetMcpToolResult,
	type WidgetMcpToolResult,
} from "./widget-test-result";

// =============================================================================
// MCP CLIENT (lightweight, no SDK dependency)
// =============================================================================

interface BrowserQaCapture {
	console: WidgetBrowserQaEvidence["console"];
	network: WidgetBrowserQaEvidence["network"];
	layout: WidgetBrowserQaEvidence["layout"];
}

const EMPTY_BROWSER_QA_CAPTURE: BrowserQaCapture = {
	console: {
		captured: false,
		errorCount: 1,
		errors: [{ type: "qa", text: "Browser QA console evidence missing" }],
		messages: [],
	},
	network: {
		captured: false,
		errorCount: 1,
		failureCount: 1,
		responseErrorCount: 0,
		failures: [{ url: "", errorText: "Browser QA network evidence missing" }],
		responseErrors: [],
	},
	layout: {
		viewport: { width: 0, height: 0 },
		document: { width: 0, height: 0 },
		widget: null,
	},
};

function browserQaObserverSetupCode(): string[] {
	return [
		`if not hasattr(page, "_tedix_qa_observers_ready"):`,
		`    page._tedix_console_messages = []`,
		`    page._tedix_network_failures = []`,
		`    page._tedix_network_response_errors = []`,
		`    def _tedix_console_message(msg):`,
		`        try:`,
		`            page._tedix_console_messages.append({"type": msg.type, "text": msg.text, "location": msg.location})`,
		`        except Exception as exc:`,
		`            page._tedix_console_messages.append({"type": "qa", "text": str(exc), "location": {}})`,
		`    def _tedix_page_error(exc):`,
		`        page._tedix_console_messages.append({"type": "pageerror", "text": str(exc), "location": {}})`,
		`    def _tedix_request_failed(request):`,
		`        try:`,
		`            failure = getattr(request, "failure", None)`,
		`            page._tedix_network_failures.append({"url": request.url, "method": request.method, "resourceType": request.resource_type, "errorText": str(failure or "")})`,
		`        except Exception as exc:`,
		`            page._tedix_network_failures.append({"url": "", "errorText": str(exc)})`,
		`    def _tedix_response(response):`,
		`        try:`,
		`            if response.status >= 400:`,
		`                req = response.request`,
		`                page._tedix_network_response_errors.append({"url": response.url, "method": req.method, "resourceType": req.resource_type, "status": response.status, "statusText": response.status_text})`,
		`        except Exception as exc:`,
		`            page._tedix_network_failures.append({"url": "", "errorText": str(exc)})`,
		`    page.on("console", _tedix_console_message)`,
		`    page.on("pageerror", _tedix_page_error)`,
		`    page.on("requestfailed", _tedix_request_failed)`,
		`    page.on("response", _tedix_response)`,
		`    page._tedix_qa_observers_ready = True`,
	];
}

function browserQaEvidencePrintCode(marker = "QA_EVIDENCE"): string[] {
	return [
		`layout = await page.evaluate("""() => {`,
		`    const widget = document.querySelector(".widget-container");`,
		`    const rect = widget ? widget.getBoundingClientRect() : null;`,
		`    return {`,
		`        viewport: { width: window.innerWidth, height: window.innerHeight },`,
		`        document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },`,
		`        widget: rect ? { width: rect.width, height: rect.height, x: rect.x, y: rect.y } : null`,
		`    };`,
		`}""")`,
		`console_messages = list(getattr(page, "_tedix_console_messages", []))[-50:]`,
		`console_errors = [m for m in console_messages if m.get("type") in ["error", "pageerror"]]`,
		`network_failures = list(getattr(page, "_tedix_network_failures", []))[-50:]`,
		`network_responses = list(getattr(page, "_tedix_network_response_errors", []))[-50:]`,
		`print("${marker}:" + json.dumps({`,
		`    "console": {`,
		`        "captured": hasattr(page, "_tedix_qa_observers_ready"),`,
		`        "errorCount": len(console_errors),`,
		`        "errors": console_errors,`,
		`        "messages": console_messages,`,
		`    },`,
		`    "network": {`,
		`        "captured": hasattr(page, "_tedix_qa_observers_ready"),`,
		`        "errorCount": len(network_failures) + len(network_responses),`,
		`        "failureCount": len(network_failures),`,
		`        "responseErrorCount": len(network_responses),`,
		`        "failures": network_failures,`,
		`        "responseErrors": network_responses,`,
		`    },`,
		`    "layout": layout,`,
		`} ))`,
	];
}

function parseBrowserQaCapture(output: string): BrowserQaCapture {
	const match = output.match(/QA_EVIDENCE:(.+)/);
	if (!match?.[1]) return EMPTY_BROWSER_QA_CAPTURE;
	try {
		const parsed = JSON.parse(match[1]) as BrowserQaCapture;
		return {
			console: {
				captured: parsed.console?.captured === true,
				errorCount: numericResult(parsed.console?.errorCount) ?? 1,
				errors: Array.isArray(parsed.console?.errors)
					? parsed.console.errors
					: [],
				messages: Array.isArray(parsed.console?.messages)
					? parsed.console.messages
					: [],
			},
			network: {
				captured: parsed.network?.captured === true,
				errorCount: numericResult(parsed.network?.errorCount) ?? 1,
				failureCount: numericResult(parsed.network?.failureCount) ?? 0,
				responseErrorCount:
					numericResult(parsed.network?.responseErrorCount) ?? 0,
				failures: Array.isArray(parsed.network?.failures)
					? parsed.network.failures
					: [],
				responseErrors: Array.isArray(parsed.network?.responseErrors)
					? parsed.network.responseErrors
					: [],
			},
			layout: normalizeBrowserQaLayout(parsed.layout),
		};
	} catch {
		return EMPTY_BROWSER_QA_CAPTURE;
	}
}

function normalizeBrowserQaLayout(
	value: unknown,
): WidgetBrowserQaEvidence["layout"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return EMPTY_BROWSER_QA_CAPTURE.layout;
	}
	const record = value as Record<string, unknown>;
	const viewport = readDimension(record.viewport);
	const document = readDimension(record.document);
	const widget =
		record.widget && typeof record.widget === "object"
			? (record.widget as Record<string, unknown>)
			: null;
	return {
		viewport,
		document,
		widget: widget
			? {
					width: numericResult(widget.width) ?? 0,
					height: numericResult(widget.height) ?? 0,
					x: numericResult(widget.x) ?? 0,
					y: numericResult(widget.y) ?? 0,
				}
			: null,
	};
}

function readDimension(value: unknown): { width: number; height: number } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { width: 0, height: 0 };
	}
	const record = value as Record<string, unknown>;
	return {
		width: numericResult(record.width) ?? 0,
		height: numericResult(record.height) ?? 0,
	};
}

function browserQaBlockingErrors(capture: BrowserQaCapture): string[] {
	const errors: string[] = [];
	if (!capture.console.captured) {
		errors.push("Browser console evidence was not captured");
	}
	if (capture.console.errorCount > 0) {
		errors.push(
			...capture.console.errors.map((error) => {
				const text = typeof error.text === "string" ? error.text : "";
				const type = typeof error.type === "string" ? error.type : "console";
				return `${type}: ${text}`.trim();
			}),
		);
	}
	if (!capture.network.captured) {
		errors.push("Browser network evidence was not captured");
	}
	if (capture.network.errorCount > 0) {
		errors.push(
			...capture.network.failures.map((failure) => {
				const url = typeof failure.url === "string" ? failure.url : "";
				const errorText =
					typeof failure.errorText === "string" ? failure.errorText : "";
				return `Network failure: ${url} ${errorText}`.trim();
			}),
			...capture.network.responseErrors.map((response) => {
				const status =
					typeof response.status === "number" ? response.status : "unknown";
				const url = typeof response.url === "string" ? response.url : "";
				return `Network response ${status}: ${url}`.trim();
			}),
		);
	}
	if (
		capture.layout.viewport.width <= 0 ||
		capture.layout.viewport.height <= 0
	) {
		errors.push("Browser layout dimensions were not captured");
	}
	return errors;
}

function buildBrowserQaEvidence(params: {
	capture: BrowserQaCapture;
	screenshotUrl: string;
	mimeType: string;
	label: string;
}): WidgetBrowserQaEvidence {
	return {
		capturedAt: new Date().toISOString(),
		screenshot: {
			url: params.screenshotUrl,
			mimeType: params.mimeType,
			label: params.label,
		},
		console: params.capture.console,
		network: params.capture.network,
		layout: params.capture.layout,
	};
}

function visualDiffPassedForBrowserQa(
	visualDiff: WidgetVisualDiffOutput | null,
): boolean {
	if (!visualDiff) return true;
	if (visualDiff.status === "failed") return false;
	if (visualDiff.status === "compared" && visualDiff.passed === false) {
		return false;
	}
	return true;
}

async function callWidgetMcpTool(
	mcpUrl: string,
	mcpHost: string,
	toolName: string,
	args: Record<string, unknown>,
	fetcher?: Fetcher,
	authHeaders?: Record<string, string>,
): Promise<WidgetMcpToolResult> {
	const result = await callSharedMcpTool(mcpUrl, toolName, args, {
		clientName: "tedix-widget-tester",
		fetchFn: fetcher ? serviceBindingFetchFn(fetcher) : undefined,
		headers: {
			"X-Tedix-Host": mcpHost,
			...authHeaders,
		},
		timeout: 15000,
	});
	if (!result.success) {
		throw new Error(result.error ?? "MCP tool call failed");
	}
	return normalizeWidgetMcpToolResult(result.rawResult ?? {}, toolName);
}

// =============================================================================
// SPEC ANALYSIS
// =============================================================================

type ElementMap = Record<string, Record<string, unknown>>;

function describeElement(
	key: string,
	elements: ElementMap,
	depth: number,
	visited: Set<string>,
): string[] {
	const indent = "  ".repeat(depth);
	if (visited.has(key)) return [`${indent}- ${key} [CIRCULAR]`];
	visited.add(key);

	const el = elements[key];
	if (!el) return [`${indent}- ${key} [MISSING]`];

	const type = typeof el.type === "string" ? el.type : "unknown";
	const props: string[] = [];

	const elProps = (el.props ?? {}) as Record<string, unknown>;
	for (const prop of ["title", "label", "text"]) {
		if (elProps[prop] != null) {
			const val = String(elProps[prop]);
			props.push(
				`${prop}="${val.length > 30 ? `${val.slice(0, 30)}...` : val}"`,
			);
		}
	}
	if (el.repeat != null) {
		const r = el.repeat as Record<string, unknown>;
		props.push(`repeat=${r.statePath ?? "?"}`);
	}
	if (el.visible != null) props.push("visible=conditional");

	const propsStr = props.length > 0 ? ` (${props.join(", ")})` : "";
	const lines: string[] = [`${indent}- ${key}: ${type}${propsStr}`];

	const children = el.children;
	if (Array.isArray(children)) {
		for (const childKey of children) {
			if (typeof childKey === "string") {
				lines.push(...describeElement(childKey, elements, depth + 1, visited));
			}
		}
	}

	return lines;
}

function collectBindings(obj: unknown, bindings: Set<string>): void {
	if (obj == null || typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (const item of obj) collectBindings(item, bindings);
		return;
	}
	const record = obj as Record<string, unknown>;
	if (typeof record.$state === "string") bindings.add(record.$state);
	if (typeof record.$bindState === "string") bindings.add(record.$bindState);
	for (const value of Object.values(record)) collectBindings(value, bindings);
}

interface SpecIssue {
	severity: "error" | "warning";
	message: string;
}

function analyzeSpec(
	spec: Record<string, unknown>,
	data: Record<string, unknown>,
): {
	componentTree: string;
	totalElements: number;
	stateKeys: string[];
	dataBindings: string[];
	issues: SpecIssue[];
} {
	const elements = (spec.elements ?? {}) as ElementMap;
	const root = spec.root as string | undefined;
	const state = spec.state as Record<string, unknown> | undefined;
	const issues: SpecIssue[] = [];

	// Component tree
	const tree = root
		? describeElement(root, elements, 0, new Set()).join("\n")
		: "(no root)";

	// State keys (from spec.state merged with data)
	const mergedState = { ...state, ...data };
	const stateKeys = Object.keys(mergedState);

	// Data bindings
	const bindings = new Set<string>();
	collectBindings(elements, bindings);
	const dataBindings = Array.from(bindings).sort();

	// Validation checks
	if (!root) {
		issues.push({ severity: "error", message: "Spec is missing `root` key." });
	} else if (!elements[root]) {
		issues.push({
			severity: "error",
			message: `Root "${root}" not found in elements.`,
		});
	}

	// Dangling children
	for (const [key, el] of Object.entries(elements)) {
		const children = el.children;
		if (Array.isArray(children)) {
			for (const childKey of children) {
				if (typeof childKey === "string" && !elements[childKey]) {
					issues.push({
						severity: "error",
						message: `"${key}" references missing child "${childKey}".`,
					});
				}
			}
		}
	}

	// State bindings referencing missing keys
	for (const binding of dataBindings) {
		const rootKey = binding.startsWith("/")
			? binding.split("/")[1]
			: binding.split("/")[0];
		if (rootKey && !mergedState[rootKey]) {
			issues.push({
				severity: "warning",
				message: `Binding "${binding}" references "${rootKey}" not found in state/data.`,
			});
		}
	}

	// Repeat paths check
	for (const el of Object.values(elements)) {
		if (el.repeat != null) {
			const r = el.repeat as Record<string, unknown>;
			const sp = r.statePath as string | undefined;
			if (sp) {
				const rootKey = sp.startsWith("/") ? sp.split("/")[1] : sp;
				const val = mergedState[rootKey ?? ""];
				if (val === undefined) {
					issues.push({
						severity: "warning",
						message: `Repeat path "${sp}" references "${rootKey}" not found in data.`,
					});
				} else if (!Array.isArray(val)) {
					issues.push({
						severity: "warning",
						message: `Repeat path "${sp}" resolves to ${typeof val}, expected array.`,
					});
				} else if (val.length === 0) {
					issues.push({
						severity: "warning",
						message: `Repeat path "${sp}" is an empty array — widget will show no items.`,
					});
				}
			}
		}
	}

	return {
		componentTree: tree,
		totalElements: Object.keys(elements).length,
		stateKeys,
		dataBindings,
		issues,
	};
}

// =============================================================================
// ROUTER
// =============================================================================

const widgetTestOs = implement(widgetTestContract).$context<BaseContext>();
const authed = widgetTestOs.use(withAuth).use(withFleetAuthority);

function isServiceOrPlatformPrincipal(context: BaseContext): boolean {
	return context.authType === "service-binding" || isPlatformPrincipal(context);
}

function assertCanTestApp(
	context: BaseContext,
	appOrganizationId: string | null,
): void {
	if (isServiceOrPlatformPrincipal(context)) return;

	if (!context.organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
	}
	if (appOrganizationId !== context.organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"App does not belong to caller organization",
		);
	}
}

function buildInternalMcpHeaders(
	context: BaseContext,
	organizationId: string | null,
): Record<string, string> {
	const serviceToken = (
		context.env as CloudflareEnv & { PLATFORM_SERVICE_TOKEN?: string }
	).PLATFORM_SERVICE_TOKEN;
	return {
		"X-Service-Binding": "true",
		...(organizationId ? { "X-Tedix-Org-Id": organizationId } : {}),
		...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
	};
}

const VISUAL_DIFF_PIXEL_DELTA_THRESHOLD = 48;
const VISUAL_DIFF_RATIO_THRESHOLD = 0.05;

function visualDiffThreshold() {
	return {
		pixelDelta: VISUAL_DIFF_PIXEL_DELTA_THRESHOLD,
		diffRatio: VISUAL_DIFF_RATIO_THRESHOLD,
	};
}

function skippedVisualDiff(
	reason: string,
	params?: {
		baseline?: WidgetVisualDiffOutput["baseline"];
		currentScreenshotUrl?: string | null;
	},
): WidgetVisualDiffOutput {
	return {
		status: "skipped",
		baseline: params?.baseline ?? null,
		currentScreenshotUrl: params?.currentScreenshotUrl ?? null,
		dimensions: null,
		pixelsCompared: null,
		differentPixels: null,
		diffRatio: null,
		averageDelta: null,
		threshold: visualDiffThreshold(),
		passed: null,
		reason,
	};
}

function failedVisualDiff(
	reason: string,
	params: {
		baseline: WidgetVisualDiffOutput["baseline"];
		currentScreenshotUrl: string | null;
	},
): WidgetVisualDiffOutput {
	return {
		status: "failed",
		baseline: params.baseline,
		currentScreenshotUrl: params.currentScreenshotUrl,
		dimensions: null,
		pixelsCompared: null,
		differentPixels: null,
		diffRatio: null,
		averageDelta: null,
		threshold: visualDiffThreshold(),
		passed: null,
		reason,
	};
}

function bytesToBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function numericResult(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function computeVisualDiff(params: {
	browser: FirecrawlBrowserClient;
	sessionId: string;
	baseline: NonNullable<WidgetVisualDiffOutput["baseline"]> | undefined;
	currentScreenshotUrl: string | null;
	currentScreenshotBytes: Uint8Array | null;
	currentMimeType: string;
}): Promise<WidgetVisualDiffOutput> {
	if (!params.baseline) {
		return skippedVisualDiff("No prior promoted or passed baseline run found", {
			currentScreenshotUrl: params.currentScreenshotUrl,
		});
	}
	if (!params.currentScreenshotUrl || !params.currentScreenshotBytes) {
		return skippedVisualDiff("Current run did not capture a screenshot", {
			baseline: params.baseline,
			currentScreenshotUrl: params.currentScreenshotUrl,
		});
	}

	let baselineBytes: Uint8Array;
	let baselineMimeType = "image/png";
	try {
		const response = await fetch(params.baseline.screenshotUrl);
		if (!response.ok) {
			return failedVisualDiff(
				`Baseline screenshot fetch failed (${response.status})`,
				{
					baseline: params.baseline,
					currentScreenshotUrl: params.currentScreenshotUrl,
				},
			);
		}
		const contentType = response.headers.get("content-type");
		if (contentType?.startsWith("image/")) baselineMimeType = contentType;
		baselineBytes = new Uint8Array(await response.arrayBuffer());
	} catch (err) {
		return failedVisualDiff(
			`Baseline screenshot fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			{
				baseline: params.baseline,
				currentScreenshotUrl: params.currentScreenshotUrl,
			},
		);
	}

	const payload = {
		baselineUrl: `data:${baselineMimeType};base64,${bytesToBase64(baselineBytes)}`,
		currentUrl: `data:${params.currentMimeType};base64,${bytesToBase64(params.currentScreenshotBytes)}`,
		pixelDeltaThreshold: VISUAL_DIFF_PIXEL_DELTA_THRESHOLD,
		diffRatioThreshold: VISUAL_DIFF_RATIO_THRESHOLD,
	};

	const code = [
		`import json`,
		`payload = json.loads(${JSON.stringify(JSON.stringify(payload))})`,
		`await page.goto("about:blank")`,
		`result = await page.evaluate("""async (payload) => {`,
		`  const loadImage = (src) => new Promise((resolve, reject) => {`,
		`    const image = new Image();`,
		`    image.onload = () => resolve(image);`,
		`    image.onerror = () => reject(new Error("Image failed to load"));`,
		`    image.src = src;`,
		`  });`,
		`  const [baseline, current] = await Promise.all([`,
		`    loadImage(payload.baselineUrl),`,
		`    loadImage(payload.currentUrl),`,
		`  ]);`,
		`  const baselineWidth = baseline.naturalWidth || baseline.width;`,
		`  const baselineHeight = baseline.naturalHeight || baseline.height;`,
		`  const currentWidth = current.naturalWidth || current.width;`,
		`  const currentHeight = current.naturalHeight || current.height;`,
		`  const width = Math.min(baselineWidth, currentWidth);`,
		`  const height = Math.min(baselineHeight, currentHeight);`,
		`  const maxWidth = Math.max(baselineWidth, currentWidth);`,
		`  const maxHeight = Math.max(baselineHeight, currentHeight);`,
		`  const canvasA = document.createElement("canvas");`,
		`  const canvasB = document.createElement("canvas");`,
		`  canvasA.width = width;`,
		`  canvasA.height = height;`,
		`  canvasB.width = width;`,
		`  canvasB.height = height;`,
		`  const ctxA = canvasA.getContext("2d", { willReadFrequently: true });`,
		`  const ctxB = canvasB.getContext("2d", { willReadFrequently: true });`,
		`  ctxA.drawImage(baseline, 0, 0);`,
		`  ctxB.drawImage(current, 0, 0);`,
		`  const dataA = ctxA.getImageData(0, 0, width, height).data;`,
		`  const dataB = ctxB.getImageData(0, 0, width, height).data;`,
		`  let differentPixels = maxWidth * maxHeight - width * height;`,
		`  let deltaTotal = 0;`,
		`  for (let i = 0; i < dataA.length; i += 4) {`,
		`    const dr = Math.abs(dataA[i] - dataB[i]);`,
		`    const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);`,
		`    const db = Math.abs(dataA[i + 2] - dataB[i + 2]);`,
		`    const da = Math.abs(dataA[i + 3] - dataB[i + 3]);`,
		`    deltaTotal += dr + dg + db + da;`,
		`    if (Math.max(dr, dg, db, da) > payload.pixelDeltaThreshold) {`,
		`      differentPixels++;`,
		`    }`,
		`  }`,
		`  const pixelsCompared = maxWidth * maxHeight;`,
		`  const diffRatio = pixelsCompared > 0 ? differentPixels / pixelsCompared : 0;`,
		`  const averageDelta = width * height > 0 ? deltaTotal / (width * height * 4 * 255) : 0;`,
		`  return {`,
		`    dimensions: {`,
		`      baseline: { width: baselineWidth, height: baselineHeight },`,
		`      current: { width: currentWidth, height: currentHeight },`,
		`    },`,
		`    pixelsCompared,`,
		`    differentPixels,`,
		`    diffRatio,`,
		`    averageDelta,`,
		`    passed: diffRatio <= payload.diffRatioThreshold,`,
		`  };`,
		`}""", payload)`,
		`print("VISUAL_DIFF:" + json.dumps(result))`,
	].join("\n");

	const execResult = await params.browser.execute(
		params.sessionId,
		code,
		"python",
	);
	const output = execResult.stdout ?? execResult.result ?? "";
	if (!execResult.success) {
		return failedVisualDiff(
			execResult.error ?? "Visual diff browser execution failed",
			{
				baseline: params.baseline,
				currentScreenshotUrl: params.currentScreenshotUrl,
			},
		);
	}

	const match = output.match(/VISUAL_DIFF:(.+)/);
	if (!match?.[1]) {
		return failedVisualDiff("Visual diff result was not returned", {
			baseline: params.baseline,
			currentScreenshotUrl: params.currentScreenshotUrl,
		});
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(match[1]) as Record<string, unknown>;
	} catch (err) {
		return failedVisualDiff(
			`Visual diff result was invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			{
				baseline: params.baseline,
				currentScreenshotUrl: params.currentScreenshotUrl,
			},
		);
	}

	const dimensions = parsed.dimensions as
		| WidgetVisualDiffOutput["dimensions"]
		| undefined;
	const diffRatio = numericResult(parsed.diffRatio);

	return {
		status: "compared",
		baseline: params.baseline,
		currentScreenshotUrl: params.currentScreenshotUrl,
		dimensions: dimensions ?? null,
		pixelsCompared: numericResult(parsed.pixelsCompared),
		differentPixels: numericResult(parsed.differentPixels),
		diffRatio,
		averageDelta: numericResult(parsed.averageDelta),
		threshold: visualDiffThreshold(),
		passed: typeof parsed.passed === "boolean" ? parsed.passed : null,
		reason:
			diffRatio != null && diffRatio > VISUAL_DIFF_RATIO_THRESHOLD
				? "Screenshot difference exceeds threshold"
				: null,
	};
}

export const runWidgetTestProcedure = authed.run
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { appSlug, toolName, toolArgs: args, format } = input;
		const viewport = input.viewport ?? { width: 420, height: 800 };
		const waitMs = input.waitMs ?? 3000;
		const { db, env } = context;
		const startTime = Date.now();

		// 1. Resolve app + tool from D1
		const app = await getAppBySlugWithTools(db, appSlug);
		if (!app) {
			throw createError(ErrorCodes.NOT_FOUND, `App not found: ${appSlug}`);
		}
		const appOrganizationId =
			(app.app as { organizationId?: string | null }).organizationId ?? null;
		assertCanTestApp(context, appOrganizationId);

		const tool = app.tools?.find((t) => t.toolId === toolName);
		if (!tool) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Tool "${toolName}" not found on app "${appSlug}". Available: ${(app.tools ?? []).map((t) => t.toolId).join(", ")}`,
			);
		}

		const config = (tool.config ?? null) as null | {
			layoutSpec?: Record<string, unknown>;
		};
		const layoutSpec = config?.layoutSpec;
		if (!layoutSpec) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Tool "${toolName}" has no layoutSpec — it may not be a widget tool.`,
			);
		}

		// 2. Call the REAL MCP tool via service binding
		const mcpBaseUrl = env.MCP_URL ?? "https://mcp.tedix.dev";
		const mcpUrl = buildMcpUrl(mcpBaseUrl);
		const mcpHost = buildMcpHost(appSlug, mcpBaseUrl);
		const mcpService = env.MCP_SERVICE;

		let mcpResult: WidgetMcpToolResult;
		try {
			mcpResult = await callWidgetMcpTool(
				mcpUrl,
				mcpHost,
				toolName,
				args,
				mcpService,
				buildInternalMcpHeaders(context, appOrganizationId),
			);
		} catch (err) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// 3. Extract real data from tool result
		const data = mcpResult.data;

		// Summarize tool result for response
		const contentText =
			mcpResult.content
				?.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n")
				.slice(0, 2000) ?? "";

		const dataKeys = Object.keys(data);
		const itemsArray = (data as Record<string, unknown>).items;
		const itemCount = Array.isArray(itemsArray) ? itemsArray.length : undefined;

		// 4. Analyze the spec against real data
		const analysis = analyzeSpec(layoutSpec, data);

		// 5. Build preview URL — spec-only (small), data injected via browser evaluate
		const specJson = JSON.stringify(layoutSpec);
		const specB64 = bytesToBase64(new TextEncoder().encode(specJson));

		const widgetUrl = env.MCP_UI_URL ?? "https://mcp-ui.tedix.dev";
		const previewUrl = `${widgetUrl}/${appSlug}/r/preview?spec=${encodeURIComponent(specB64)}`;

		// 6. Screenshot with Firecrawl Browser Sandbox (replaces Puppeteer — avoids Cloudflare WAF 403)
		const firecrawlApiKey = env.FIRECRAWL_API_KEY;
		if (!firecrawlApiKey) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"FIRECRAWL_API_KEY not configured",
			);
		}

		const browser = createFirecrawlBrowserClient(firecrawlApiKey);
		const session = await browser.launch({ ttl: 60, activityTtl: 30 });
		const consoleErrors: string[] = [];

		try {
			const dataJson = JSON.stringify(data)
				.replace(/\\/g, "\\\\")
				.replace(/'/g, "\\'");
			const escapedPreviewUrl = previewUrl.replace(/'/g, "\\'");
			const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
			const ext = format === "jpeg" ? "jpg" : "png";

			// Navigate, inject data, wait, screenshot — single Python execution
			const code = [
				`import json, base64`,
				``,
				...browserQaObserverSetupCode(),
				``,
				`await page.set_viewport_size({"width": ${viewport.width}, "height": ${viewport.height}})`,
				`await page.goto('${escapedPreviewUrl}', wait_until="networkidle")`,
				``,
				`# Wait for PreviewRenderer store`,
				`store_ready = True`,
				`try:`,
				`    await page.wait_for_function("window.__TEDIX_STORE__", timeout=10000)`,
				`except:`,
				`    store_ready = False`,
				`    print("WARN:store_timeout")`,
				``,
				`# Inject real data into the store`,
				`if store_ready:`,
				`    data = json.loads('${dataJson}')`,
				`    await page.evaluate("""(data) => {`,
				`        const store = window.__TEDIX_STORE__;`,
				`        if (store) {`,
				`            for (const [key, value] of Object.entries(data)) {`,
				`                store.set("/" + key, value);`,
				`            }`,
				`        }`,
				`    }""", data)`,
				``,
				`# Wait for widget to render`,
				`container_found = True`,
				`try:`,
				`    await page.locator(".widget-container").wait_for(state="visible", timeout=8000)`,
				`except:`,
				`    container_found = False`,
				`    print("WARN:container_timeout")`,
				``,
				`# Extra wait for animations, lazy images`,
				`await page.wait_for_timeout(${waitMs})`,
				``,
				`# Collect DOM info`,
				`dom = await page.evaluate("""() => ({`,
				`    title: document.title || '',`,
				`    elementCount: document.querySelectorAll('*').length,`,
				`    textContent: (document.body.innerText || '').substring(0, 3000)`,
				`})""")`,
				`print("DOM_INFO:" + json.dumps(dom))`,
				``,
				...browserQaEvidencePrintCode(),
				``,
				`# Take screenshot`,
				`try:`,
				`    await page.screenshot(path="/tmp/widget.${ext}", full_page=True, timeout=10000)`,
				`except:`,
				`    await page.screenshot(path="/tmp/widget.${ext}", full_page=False, timeout=10000)`,
				`with open("/tmp/widget.${ext}", "rb") as f:`,
				`    b64 = base64.b64encode(f.read()).decode()`,
				`print("SCREENSHOT_BASE64:" + b64)`,
			].join("\n");

			const execResult = await browser.execute(session.id, code, "python");
			const output = execResult.stdout ?? execResult.result ?? "";

			if (!execResult.success && execResult.error) {
				consoleErrors.push(`Firecrawl execution error: ${execResult.error}`);
			}
			if (output.includes("WARN:store_timeout")) {
				consoleErrors.push("Timeout: PreviewRenderer store not available");
			}
			if (output.includes("WARN:container_timeout")) {
				consoleErrors.push("Timeout: .widget-container not found");
			}
			const browserQaCapture = parseBrowserQaCapture(output);
			consoleErrors.push(...browserQaBlockingErrors(browserQaCapture));

			// Parse DOM info
			let domInfo = { title: "", elementCount: 0, textContent: "" };
			const domMatch = output.match(/DOM_INFO:(.+)/);
			if (domMatch?.[1]) {
				try {
					domInfo = JSON.parse(domMatch[1]);
				} catch {
					/* keep defaults */
				}
			}

			// Extract screenshot and upload to R2
			let screenshotUrl = "";
			let screenshotBytes: Uint8Array | null = null;
			const b64Match = output.match(/SCREENSHOT_BASE64:(.+)/s);
			if (b64Match?.[1]) {
				const screenshotData = b64Match[1].trim();
				const binaryStr = atob(screenshotData);
				const bytes = new Uint8Array(binaryStr.length);
				for (let j = 0; j < binaryStr.length; j++) {
					bytes[j] = binaryStr.charCodeAt(j);
				}
				screenshotBytes = bytes;
				const key = `widget-tests/${appSlug}/${toolName}-${Date.now()}.${ext}`;
				await env.R2_BUCKET.put(key, bytes, {
					httpMetadata: { contentType: mimeType },
				});
				const assetsUrl = env.ASSETS_URL ?? "https://pub-tedix-assets.r2.dev";
				screenshotUrl = `${assetsUrl}/${key}`;
			} else {
				consoleErrors.push("No screenshot captured");
			}

			const organizationId =
				appOrganizationId ?? context.organizationId ?? null;
			const baseline =
				organizationId && app.app.id
					? await getLatestWidgetVisualDiffBaseline(db, {
							organizationId,
							appId: app.app.id,
							appSlug,
							toolName,
							appToolId: tool.id,
							toolId: tool.toolId,
						})
					: undefined;
			const visualDiff = await computeVisualDiff({
				browser,
				sessionId: session.id,
				baseline: baseline ?? undefined,
				currentScreenshotUrl: screenshotUrl || null,
				currentScreenshotBytes: screenshotBytes,
				currentMimeType: mimeType,
			});
			if (!visualDiffPassedForBrowserQa(visualDiff)) {
				consoleErrors.push(
					visualDiff.reason ?? "Visual diff failed Browser QA gate",
				);
			}
			const qaEvidence = buildBrowserQaEvidence({
				capture: browserQaCapture,
				screenshotUrl,
				mimeType,
				label: "full-page",
			});

			const result = {
				screenshotUrl,
				previewUrl,
				mimeType,
				toolResult: {
					contentSummary: contentText,
					dataKeys,
					itemCount,
					isError: false,
				},
				widgetAnalysis: analysis,
				domSummary: {
					...domInfo,
					errors: consoleErrors,
					qaEvidence,
				},
				visualDiff,
				renderTimeMs: Date.now() - startTime,
			};

			// Persist test run (fire-and-forget)
			const runId = crypto.randomUUID();
			insertWidgetTestRun(db, {
				id: runId,
				appId: app.app.id,
				appSlug,
				organizationId,
				toolName,
				toolArgs: toJsonRecord(args),
				mode: "static",
				passed:
					screenshotUrl.length > 0 &&
					consoleErrors.length === 0 &&
					analysis.issues.filter((i) => i.severity === "error").length === 0,
				stepCount: null,
				stepsPassedCount: null,
				stepResults: null,
				screenshots: screenshotUrl
					? [{ label: "full-page", url: screenshotUrl, mimeType }]
					: [],
				toolResult: toJsonRecord(result.toolResult),
				domSummary: toJsonRecord(result.domSummary),
				widgetAnalysis: toJsonRecord(result.widgetAnalysis),
				visualDiff: result.visualDiff,
				previewUrl,
				durationMs: result.renderTimeMs,
				error: null,
			}).catch(() => {});

			return result;
		} finally {
			await browser.close(session.id).catch(() => {});
		}
	});

// =============================================================================
// INTERACTIVE TEST (Firecrawl Browser Sandbox)
// =============================================================================

/**
 * Build Playwright Python code for a single interaction step.
 * Each step runs in the Firecrawl sandbox with `page` already available.
 *
 * IMPORTANT: Firecrawl Browser Sandbox only captures output via Python's
 * `print()` → `stdout`. Node's `console.log()` is silently dropped.
 * All code therefore uses Python (language: "python").
 */
function buildStepCode(step: InteractionStep): string {
	switch (step.action) {
		case "click": {
			if (step.text) {
				const idx = step.index ?? 0;
				const escaped = step.text.replace(/"/g, '\\"');
				return [
					`els = await page.locator("button, a, [role=button]", has_text="${escaped}").all()`,
					`if len(els) == 0: raise Exception("No element with text: ${escaped}")`,
					`await els[${idx}].click()`,
					`await page.wait_for_timeout(500)`,
					`print("OK")`,
				].join("\n");
			}
			if (step.selector) {
				const idx = step.index ?? 0;
				const escaped = step.selector.replace(/"/g, '\\"');
				return [
					`els = await page.locator("${escaped}").all()`,
					`if len(els) == 0: raise Exception("No element matching: ${escaped}")`,
					`await els[${idx}].click()`,
					`await page.wait_for_timeout(500)`,
					`print("OK")`,
				].join("\n");
			}
			throw new Error("click step needs selector or text");
		}
		case "type": {
			const sel = step.selector.replace(/"/g, '\\"');
			const txt = step.text.replace(/"/g, '\\"');
			return `await page.locator("${sel}").fill("${txt}")\nprint("OK")`;
		}
		case "press": {
			const key = step.key.replace(/"/g, '\\"');
			// Use page.press("body", key) — page.keyboard.press() can timeout in Firecrawl sandbox
			return `await page.press("body", "${key}")\nprint("OK")`;
		}
		case "wait":
			return `await page.wait_for_timeout(${step.ms ?? 1000})\nprint("OK")`;
		case "waitFor": {
			const sel = step.selector.replace(/"/g, '\\"');
			const state = step.state ?? "visible";
			const timeout = step.timeout ?? 5000;
			return `await page.locator("${sel}").wait_for(state="${state}", timeout=${timeout})\nprint("OK")`;
		}
		case "screenshot": {
			const fullPage = step.fullPage ?? true;
			// full_page=True can timeout with overlays/dialogs — fallback to viewport screenshot
			return [
				`import base64`,
				`try:`,
				`    await page.screenshot(path="/tmp/step-screenshot.png", full_page=${fullPage ? "True" : "False"}, timeout=10000)`,
				`except:`,
				`    await page.screenshot(path="/tmp/step-screenshot.png", full_page=False, timeout=10000)`,
				`with open("/tmp/step-screenshot.png", "rb") as f:`,
				`    b64 = base64.b64encode(f.read()).decode()`,
				`print("SCREENSHOT_BASE64:" + b64)`,
			].join("\n");
		}
		case "assert": {
			const lines: string[] = [];
			if (step.selector && step.visible === true) {
				const sel = step.selector.replace(/"/g, '\\"');
				lines.push(
					`vis = await page.locator("${sel}").is_visible()`,
					`if not vis: raise Exception("Expected visible: ${sel}")`,
				);
			}
			if (step.selector && step.visible === false) {
				const sel = step.selector.replace(/"/g, '\\"');
				lines.push(
					`vis = await page.locator("${sel}").is_visible()`,
					`if vis: raise Exception("Expected hidden: ${sel}")`,
				);
			}
			if (step.selector && step.text) {
				const sel = step.selector.replace(/"/g, '\\"');
				const txt = step.text.replace(/"/g, '\\"');
				lines.push(
					`txt = await page.locator("${sel}").text_content()`,
					`if txt is None or "${txt}" not in txt: raise Exception(f"Expected text '${txt}' in ${sel}, got: {(txt or '')[:100]}")`,
				);
			}
			if (step.selector && step.count !== undefined) {
				const sel = step.selector.replace(/"/g, '\\"');
				lines.push(
					`cnt = await page.locator("${sel}").count()`,
					`if cnt != ${step.count}: raise Exception(f"Expected ${step.count} elements for ${sel}, got: {cnt}")`,
				);
			}
			lines.push(`print("OK")`);
			return lines.join("\n");
		}
		case "scroll": {
			if (step.selector) {
				const sel = step.selector.replace(/"/g, '\\"');
				return `await page.locator("${sel}").evaluate("(el, args) => el.scrollBy(args.x, args.y)", {"x": ${step.x ?? 0}, "y": ${step.y ?? 300}})\nprint("OK")`;
			}
			return `await page.evaluate("(args) => window.scrollBy(args.x, args.y)", {"x": ${step.x ?? 0}, "y": ${step.y ?? 300}})\nprint("OK")`;
		}
		default:
			throw new Error(
				`Unknown step action: ${(step as { action: string }).action}`,
			);
	}
}

export const runInteractiveWidgetTestProcedure = authed.runInteractive
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { appSlug, toolName, toolArgs: args, steps } = input;
		const viewport = input.viewport ?? { width: 420, height: 800 };
		const waitMs = input.waitMs ?? 3000;
		const { db, env } = context;
		const startTime = Date.now();

		// 1. Resolve app + tool from D1
		const app = await getAppBySlugWithTools(db, appSlug);
		if (!app) {
			throw createError(ErrorCodes.NOT_FOUND, `App not found: ${appSlug}`);
		}
		const appOrganizationId =
			(app.app as { organizationId?: string | null }).organizationId ?? null;
		assertCanTestApp(context, appOrganizationId);

		const tool = app.tools?.find((t) => t.toolId === toolName);
		if (!tool) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Tool "${toolName}" not found on app "${appSlug}".`,
			);
		}

		const config = (tool.config ?? null) as null | {
			layoutSpec?: Record<string, unknown>;
		};
		const layoutSpec = config?.layoutSpec;
		if (!layoutSpec) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Tool "${toolName}" has no layoutSpec.`,
			);
		}

		// 2. Call the REAL MCP tool
		const mcpBaseUrl = env.MCP_URL ?? "https://mcp.tedix.dev";
		const mcpUrl = buildMcpUrl(mcpBaseUrl);
		const mcpHost = buildMcpHost(appSlug, mcpBaseUrl);
		const mcpService = env.MCP_SERVICE;

		let mcpResult: WidgetMcpToolResult;
		try {
			mcpResult = await callWidgetMcpTool(
				mcpUrl,
				mcpHost,
				toolName,
				args,
				mcpService,
				buildInternalMcpHeaders(context, appOrganizationId),
			);
		} catch (err) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const data = mcpResult.data;
		const contentText =
			mcpResult.content
				?.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n")
				.slice(0, 2000) ?? "";
		const dataKeys = Object.keys(data);
		const itemsArray = (data as Record<string, unknown>).items;
		const itemCount = Array.isArray(itemsArray) ? itemsArray.length : undefined;

		// 3. Build preview URL (spec-only, data injected via Playwright)
		const specJson = JSON.stringify(layoutSpec);
		const specB64 = bytesToBase64(new TextEncoder().encode(specJson));
		const widgetUrl = env.MCP_UI_URL ?? "https://mcp-ui.tedix.dev";
		const previewUrl = `${widgetUrl}/${appSlug}/r/preview?spec=${encodeURIComponent(specB64)}`;

		// 4. Launch Firecrawl browser session
		const firecrawlApiKey = env.FIRECRAWL_API_KEY;
		if (!firecrawlApiKey) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"FIRECRAWL_API_KEY not configured",
			);
		}

		const browser = createFirecrawlBrowserClient(firecrawlApiKey);
		const session = await browser.launch({ ttl: 60, activityTtl: 30 });

		const stepResults: Array<{
			step: number;
			action: string;
			label?: string;
			success: boolean;
			error?: string;
			screenshotUrl?: string;
			durationMs: number;
		}> = [];
		const screenshots: Array<{ label: string; url: string; mimeType: string }> =
			[];
		const consoleErrors: string[] = [];

		try {
			// 5. Navigate and inject data (Python — only language with stdout capture in Firecrawl)
			const dataJson = JSON.stringify(data)
				.replace(/\\/g, "\\\\")
				.replace(/'/g, "\\'");
			const escapedPreviewUrl = previewUrl.replace(/'/g, "\\'");
			const setupCode = [
				`import json`,
				``,
				...browserQaObserverSetupCode(),
				``,
				`await page.set_viewport_size({"width": ${viewport.width}, "height": ${viewport.height}})`,
				`await page.goto('${escapedPreviewUrl}', wait_until="networkidle")`,
				``,
				`# Wait for PreviewRenderer store`,
				`try:`,
				`    await page.wait_for_function("window.__TEDIX_STORE__", timeout=10000)`,
				`except:`,
				`    print("WARN:store_timeout")`,
				``,
				`# Inject data`,
				`data = json.loads('${dataJson}')`,
				`await page.evaluate("""(data) => {`,
				`    const store = window.__TEDIX_STORE__;`,
				`    if (store) {`,
				`        for (const [key, value] of Object.entries(data)) {`,
				`            store.set("/" + key, value);`,
				`        }`,
				`    }`,
				`}""", data)`,
				``,
				`# Wait for render`,
				`await page.wait_for_timeout(${waitMs})`,
				``,
				`# Collect page info`,
				`text = await page.evaluate("() => (document.body.innerText || '').substring(0, 3000)")`,
				`el_count = await page.evaluate("() => document.querySelectorAll('*').length")`,
				`title = await page.evaluate("() => document.title")`,
				`print("DOM_INFO:" + json.dumps({"title": title, "elementCount": el_count, "textContent": text}))`,
			].join("\n");

			const setupResult = await browser.execute(
				session.id,
				setupCode,
				"python",
			);
			if (!setupResult.success && setupResult.error) {
				consoleErrors.push(`Setup error: ${setupResult.error}`);
			}

			// Parse DOM info from stdout (Python print() → stdout field)
			const setupOutput = setupResult.stdout ?? setupResult.result ?? "";
			let domInfo = { title: "", elementCount: 0, textContent: "" };
			const domMatch = setupOutput.match(/DOM_INFO:(.+)/);
			if (domMatch?.[1]) {
				try {
					domInfo = JSON.parse(domMatch[1]);
				} catch {
					/* keep defaults */
				}
			}
			if (setupOutput.includes("WARN:store_timeout")) {
				consoleErrors.push("PreviewRenderer store not available within 10s");
			}

			// 6. Execute interaction steps
			for (let i = 0; i < steps.length; i++) {
				const step = steps[i]!;
				const stepStart = Date.now();
				const stepLabel =
					step.action === "screenshot"
						? (step as { label: string }).label
						: undefined;
				const result: (typeof stepResults)[number] = {
					step: i,
					action: step.action,
					label: stepLabel,
					success: false,
					durationMs: 0,
				};

				try {
					const code = buildStepCode(step);
					const execResult = await browser.execute(session.id, code, "python");

					if (!execResult.success) {
						result.error = execResult.error ?? "Execution failed";
					} else {
						result.success = true;

						// Handle screenshot results (Python print() → stdout)
						const stepOutput = execResult.stdout ?? execResult.result ?? "";
						if (step.action === "screenshot" && stepOutput) {
							const ssLabel = (step as { label: string }).label;
							const b64Match = stepOutput.match(/SCREENSHOT_BASE64:(.+)/s);
							if (b64Match?.[1]) {
								const screenshotData = b64Match[1].trim();
								const binaryStr = atob(screenshotData);
								const bytes = new Uint8Array(binaryStr.length);
								for (let j = 0; j < binaryStr.length; j++) {
									bytes[j] = binaryStr.charCodeAt(j);
								}

								const key = `widget-tests/${appSlug}/${toolName}-${ssLabel}-${Date.now()}.png`;
								await env.R2_BUCKET.put(key, bytes, {
									httpMetadata: { contentType: "image/png" },
								});
								const assetsUrl =
									env.ASSETS_URL ?? "https://pub-tedix-assets.r2.dev";
								const screenshotUrl = `${assetsUrl}/${key}`;
								result.screenshotUrl = screenshotUrl;
								screenshots.push({
									label: ssLabel,
									url: screenshotUrl,
									mimeType: "image/png",
								});
							}
						}
					}
				} catch (err) {
					result.error = err instanceof Error ? err.message : String(err);
				}

				result.durationMs = Date.now() - stepStart;
				stepResults.push(result);
			}

			// 7. Final DOM summary (after all interactions)
			const finalCode = [
				`import json, base64`,
				`text = await page.evaluate("() => (document.body.innerText || '').substring(0, 3000)")`,
				`el_count = await page.evaluate("() => document.querySelectorAll('*').length")`,
				`title = await page.evaluate("() => document.title")`,
				`print("FINAL:" + json.dumps({"title": title, "elementCount": el_count, "textContent": text}))`,
				``,
				...browserQaEvidencePrintCode(),
				``,
				`try:`,
				`    await page.screenshot(path="/tmp/final-widget.png", full_page=True, timeout=10000)`,
				`except:`,
				`    await page.screenshot(path="/tmp/final-widget.png", full_page=False, timeout=10000)`,
				`with open("/tmp/final-widget.png", "rb") as f:`,
				`    b64 = base64.b64encode(f.read()).decode()`,
				`print("FINAL_SCREENSHOT_BASE64:" + b64)`,
			].join("\n");
			const finalResult = await browser.execute(
				session.id,
				finalCode,
				"python",
			);
			if (!finalResult.success && finalResult.error) {
				consoleErrors.push(`Final QA evidence error: ${finalResult.error}`);
			}

			const finalOutput = finalResult.stdout ?? finalResult.result ?? "";
			const finalMatch = finalOutput.match(/FINAL:(.+)/);
			if (finalMatch?.[1]) {
				try {
					domInfo = JSON.parse(finalMatch[1]);
				} catch {
					/* keep previous */
				}
			}
			const browserQaCapture = parseBrowserQaCapture(finalOutput);
			consoleErrors.push(...browserQaBlockingErrors(browserQaCapture));

			let finalScreenshotUrl = "";
			const finalScreenshotMatch = finalOutput.match(
				/FINAL_SCREENSHOT_BASE64:(.+)/s,
			);
			if (finalScreenshotMatch?.[1]) {
				const screenshotData = finalScreenshotMatch[1].trim();
				const binaryStr = atob(screenshotData);
				const bytes = new Uint8Array(binaryStr.length);
				for (let j = 0; j < binaryStr.length; j++) {
					bytes[j] = binaryStr.charCodeAt(j);
				}
				const key = `widget-tests/${appSlug}/${toolName}-final-${Date.now()}.png`;
				await env.R2_BUCKET.put(key, bytes, {
					httpMetadata: { contentType: "image/png" },
				});
				const assetsUrl = env.ASSETS_URL ?? "https://pub-tedix-assets.r2.dev";
				finalScreenshotUrl = `${assetsUrl}/${key}`;
				screenshots.push({
					label: "final",
					url: finalScreenshotUrl,
					mimeType: "image/png",
				});
			} else {
				consoleErrors.push("No final QA screenshot captured");
			}
			const qaEvidence = buildBrowserQaEvidence({
				capture: browserQaCapture,
				screenshotUrl: finalScreenshotUrl,
				mimeType: "image/png",
				label: "final",
			});

			const result = {
				previewUrl,
				toolResult: {
					contentSummary: contentText,
					dataKeys,
					itemCount,
					isError: false,
				},
				steps: stepResults,
				screenshots,
				domSummary: {
					title: domInfo.title || undefined,
					elementCount: domInfo.elementCount,
					textContent: domInfo.textContent,
					errors: consoleErrors,
					qaEvidence,
				},
				totalDurationMs: Date.now() - startTime,
			};

			// Persist test run (fire-and-forget — don't block response)
			const allStepsPassed = stepResults.every((s) => s.success);
			const organizationId =
				appOrganizationId ?? context.organizationId ?? null;
			insertWidgetTestRun(db, {
				id: crypto.randomUUID(),
				appId: app.app.id,
				appSlug,
				organizationId,
				toolName,
				toolArgs: toJsonRecord(args),
				mode: "interactive",
				passed:
					allStepsPassed &&
					screenshots.length > 0 &&
					consoleErrors.length === 0,
				stepCount: stepResults.length,
				stepsPassedCount: stepResults.filter((s) => s.success).length,
				stepResults,
				screenshots,
				toolResult: toJsonRecord(result.toolResult),
				domSummary: toJsonRecord(result.domSummary),
				widgetAnalysis: null,
				previewUrl,
				durationMs: result.totalDurationMs,
				error: null,
			}).catch(() => {});

			return result;
		} finally {
			// Always clean up the browser session
			await browser.close(session.id).catch(() => {});
		}
	});

export const widgetTestContractRouter = widgetTestOs.router({
	run: runWidgetTestProcedure,
	runInteractive: runInteractiveWidgetTestProcedure,
});
