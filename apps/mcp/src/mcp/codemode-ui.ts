import { type ToolProvider } from "@cloudflare/codemode";
import { autoFixSpec, isNonEmptySpec, validateSpec } from "@json-render/core";
import {
	LAYOUT_CATALOG_ACTIONS,
	LAYOUT_CATALOG_COMPONENTS,
	LAYOUT_CATALOG_JSON_SCHEMA,
	LAYOUT_CATALOG_PROMPT,
} from "@tedix/api-contract/generated/layout-catalog-prompt";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { ServerContext } from "./server-context";
import { isWidgetAppSlug } from "./utils/widget-app";

export const UI_NAMESPACE = "ui";
const GENERATED_MCP_APP_HTML_CHAR_CAP = 4_000;

const UI_PROVIDER_TYPES = [
	"declare namespace ui {",
	"  /** Inspect the model-facing json-render catalog before authoring a custom layoutSpec. Returns component/action names, schema, and compact generation rules. */",
	"  function get_catalog(input?: { components?: string[] }): Promise<{ components: string[]; componentDefinitions: string[]; actions: string[]; schema: Record<string, unknown>; rules: string[] }>;",
	"  /** Create an inline MCP UI/json-render view from data already fetched in this Code Mode run. For a genuinely generated interface, inspect ui.get_catalog(), author layoutSpec, validate it, then return create_view directly. Omit layoutSpec only when an inferred native comparison, chart, dashboard, ranking, timeline, stats, table, or summary is sufficient. */",
	'  function create_view(input: { title?: string; appSlug?: string; appName?: string; appId?: string; logoUrl?: string; layoutId?: string; layoutSpec?: Record<string, unknown>; data: Record<string, unknown> | Array<Record<string, unknown>>; summary?: string; visualKind?: "auto" | "table" | "summary" | "comparison" | "timeline" | "stats" | "details" | "chart" | "timeSeries" | "categoricalCounts" | "rankedMetrics" }): Promise<Record<string, unknown>>;',
	"  /** Create a transient free-form HTML/CSS MCP App when the catalog cannot express the requested visual. The document is rendered in a nested sandbox with scripts, forms, navigation, popups, downloads, and network access disabled. Use the host semantic CSS variables --background, --foreground, --surface, --surface-secondary, --surface-tertiary, --card, --card-foreground, --muted, --muted-foreground, --accent, --accent-foreground, and --border so it follows light/dark theme changes. Keep a meaningful summary/data fallback and return this object directly. */",
	"  function create_mcp_app(input: { title: string; html: string; summary: string; data?: Record<string, unknown>; appSlug?: string; appName?: string; appId?: string; logoUrl?: string }): Promise<Record<string, unknown>>;",
	"  /** Create a compact visual health sweep after probing multiple MCP app/provider tools. Use this instead of returning raw probe JSON when the user asks whether several tools or namespaces work. */",
	'  function create_health_sweep(input: { title?: string; appSlug?: string; appName?: string; checks: Array<{ namespace?: string; provider?: string; tool?: string; label?: string; status: "ok" | "warning" | "error" | "blocked" | "missing" | "unknown" | string; summary?: string; error?: string; latencyMs?: number }>; summary?: string }): Promise<Record<string, unknown>>;',
	"  /** Validate and auto-fix a json-render layoutSpec before returning it from ui.create_view. */",
	"  function validate_layout(input: { layoutSpec: Record<string, unknown> }): Promise<{ valid: boolean; issues: string[]; layoutSpec?: Record<string, unknown> }>;",
	"}",
].join("\n");

export const UI_CATALOG_TOOLS = {
	get_catalog: {
		name: "Inspect UI Catalog",
		description:
			"Return the current json-render component catalog, action allowlist, validation schema, and compact generation rules. Call this before authoring a custom layoutSpec instead of guessing component names.",
		parameters: {
			type: "object",
			properties: {
				components: {
					type: "array",
					items: { type: "string" },
					maxItems: 12,
					description:
						"Optional component names whose exact props/events/slots definitions should be returned. Defaults to the primary data-visualization components.",
				},
			},
		},
	},
	create_view: {
		name: "Create Visual View",
		description:
			"Create an inline MCP UI/json-render view from data already fetched in Code Mode. Use data: { items: [{ ... }] } for reliable inferred record tables, or pass a bare record array. Scalar-only objects intentionally render as stats or a summary. Use this when a visual table, chart, comparison, carousel, summary, or dashboard is clearer than plain text. Return the object from code so Tedix OS can render it.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				appSlug: {
					type: "string",
					description:
						"App slug used for theming and resource URI, for example nosana or tedix-unified.",
				},
				appName: { type: "string" },
				appId: { type: "string" },
				logoUrl: { type: "string" },
				layoutId: {
					type: "string",
					description:
						"Optional stable single-segment route id after /r/. Defaults from title.",
				},
				layoutSpec: {
					type: "object",
					description:
						"Optional json-render layout spec with root and elements. Omit for Tedix to infer a native table or summary layout from data.",
				},
				data: {
					anyOf: [
						{ type: "object" },
						{
							type: "array",
							items: { type: "object" },
						},
					],
					description:
						"Structured data consumed by layoutSpec via json-render state bindings. For inferred tables prefer { items: [{ ...record fields... }] }. Bare record arrays are accepted and normalized to { rows: [...] }. Scalar-only objects infer stats or a summary instead of a table.",
					examples: [
						{ items: [{ name: "Alpha", value: 42 }] },
						[{ name: "Alpha", value: 42 }],
					],
				},
				summary: { type: "string" },
				visualKind: {
					type: "string",
					enum: [
						"auto",
						"table",
						"summary",
						"comparison",
						"timeline",
						"stats",
						"details",
						"chart",
						"timeSeries",
						"categoricalCounts",
						"rankedMetrics",
					],
					description:
						"Optional layout hint. Defaults to auto: comparison, chart, timeline, stats, table, or summary from data shape.",
				},
			},
			required: ["data"],
		},
	},
	create_mcp_app: {
		name: "Create Generated MCP App",
		description:
			"Create a transient free-form HTML/CSS MCP App resource from this Code Mode result. Use only when json-render cannot express the visual. The host renders the generated document in a nested sandbox with scripts and external capabilities disabled. Style it with the documented host semantic CSS variables so it follows light and dark themes; include a meaningful structured fallback.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				html: {
					type: "string",
					description:
						"Self-contained semantic HTML fragment with inline CSS. Maximum 4,000 characters. Use var(--background), var(--foreground), var(--surface), var(--card), var(--muted), var(--accent), var(--border), and their foreground variants instead of fixed page colors so the result follows the MCP host theme. Do not depend on scripts, remote assets, forms, or navigation.",
				},
				summary: {
					type: "string",
					description:
						"Meaningful plain-text fallback that remains useful if the MCP App cannot mount.",
				},
				data: { type: "object" },
				appSlug: { type: "string" },
				appName: { type: "string" },
				appId: { type: "string" },
				logoUrl: { type: "string" },
			},
			required: ["title", "html", "summary"],
		},
	},
	create_health_sweep: {
		name: "Create Health Sweep",
		description:
			"Create a compact json-render health sweep from multiple provider/tool checks. Use after probing requested namespaces such as Notion, PromptWatch, Todoist, Cloudflare, Nosana, or Gmail. Return the result directly so Tedix OS renders one summary instead of many raw tool blocks.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				appSlug: {
					type: "string",
					description:
						"App slug used for theming and resource URI. Defaults to tedix-unified.",
				},
				appName: { type: "string" },
				checks: {
					type: "array",
					description:
						"One row per provider/tool probe. Keep summaries short and put raw details in error only when needed.",
					items: {
						type: "object",
						properties: {
							namespace: { type: "string" },
							provider: { type: "string" },
							tool: { type: "string" },
							label: { type: "string" },
							status: { type: "string" },
							summary: { type: "string" },
							error: { type: "string" },
							latencyMs: { type: "number" },
						},
						required: ["status"],
					},
				},
				summary: { type: "string" },
			},
			required: ["checks"],
		},
	},
	validate_layout: {
		name: "Validate Layout",
		description:
			"Validate and auto-fix a json-render layoutSpec before creating a visual view.",
		parameters: {
			type: "object",
			properties: {
				layoutSpec: {
					type: "object",
					description: "json-render layout spec with root and elements.",
				},
			},
			required: ["layoutSpec"],
		},
	},
} satisfies Record<
	string,
	{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}
>;

interface UiViewInput {
	appId?: string;
	appName?: string;
	appSlug?: string;
	data?: unknown;
	layoutId?: string;
	layoutSpec?: unknown;
	logoUrl?: string;
	summary?: string;
	title?: string;
	visualKind?: UiVisualKind;
}

interface UiHealthSweepInput {
	appName?: string;
	appSlug?: string;
	checks: Record<string, unknown>[];
	summary?: string;
	title?: string;
}

interface UiMcpAppInput {
	appId?: string;
	appName?: string;
	appSlug?: string;
	data?: Record<string, unknown>;
	html: string;
	logoUrl?: string;
	summary: string;
	title: string;
}

type HealthSweepStatus =
	| "blocked"
	| "error"
	| "missing"
	| "ok"
	| "unknown"
	| "warning";

interface NormalizedHealthSweepCheck extends Record<string, unknown> {
	label: string;
	namespace: string;
	status: HealthSweepStatus;
	tone: string;
}

interface TableCandidate {
	path: string;
	rows: Record<string, unknown>[];
}

interface ChartSeriesSpec {
	key: string;
	label: string;
	color: "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6";
}

interface ChartCandidate {
	table: TableCandidate;
	data: Record<string, unknown>[];
	variant: "area" | "bar" | "donut" | "line";
	xKey?: string;
	yKeys?: string[];
	series?: ChartSeriesSpec[];
	nameKey?: string;
	valueKey?: string;
}

type UiVisualKind =
	| "auto"
	| "categoricalCounts"
	| "chart"
	| "comparison"
	| "details"
	| "rankedMetrics"
	| "stats"
	| "summary"
	| "table"
	| "timeSeries"
	| "timeline";

interface InferredLayout {
	layoutSpec: Record<string, unknown>;
	viewData?: Record<string, unknown>;
}

export function recordFrom(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function humanizeSlug(slug: string): string {
	return slug
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function buildUiProvider(serverCtx: ServerContext): ToolProvider {
	return {
		name: UI_NAMESPACE,
		tools: {
			get_catalog: {
				description: UI_CATALOG_TOOLS.get_catalog.description,
				execute: async (input: unknown) => codeModeUiCatalog(input),
			},
			create_view: {
				description: UI_CATALOG_TOOLS.create_view.description,
				execute: async (input: unknown) =>
					createCodeModeUiView(serverCtx, normalizeUiViewInput(input)),
			},
			create_mcp_app: {
				description: UI_CATALOG_TOOLS.create_mcp_app.description,
				execute: async (input: unknown) =>
					createCodeModeMcpApp(serverCtx, normalizeUiMcpAppInput(input)),
			},
			create_health_sweep: {
				description: UI_CATALOG_TOOLS.create_health_sweep.description,
				execute: async (input: unknown) =>
					createCodeModeHealthSweep(
						serverCtx,
						normalizeUiHealthSweepInput(input),
					),
			},
			validate_layout: {
				description: UI_CATALOG_TOOLS.validate_layout.description,
				execute: async (input: unknown) => {
					const args = recordFrom(input) ?? {};
					return normalizeJsonRenderLayoutSpec(args.layoutSpec);
				},
			},
		},
		types: UI_PROVIDER_TYPES,
	};
}

const DEFAULT_UI_CATALOG_COMPONENTS = [
	"Stack",
	"Grid",
	"SectionHeader",
	"Text",
	"Badge",
	"DataTable",
	"DataChart",
	"StatGrid",
	"KeyValuePanel",
	"BarList",
	"StatusTimeline",
	"AnswerBlock",
] as const;

function codeModeUiCatalog(input: unknown): Record<string, unknown> {
	const rawComponents = recordFrom(input)?.components;
	const requested = Array.isArray(rawComponents)
		? rawComponents.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const selected = requested.length
		? requested
		: [...DEFAULT_UI_CATALOG_COMPONENTS];
	const allowed = new Set<string>(LAYOUT_CATALOG_COMPONENTS);
	const componentDefinitions = selected
		.filter(
			(name, index, names) =>
				allowed.has(name) && names.indexOf(name) === index,
		)
		.slice(0, 12)
		.map((name) =>
			LAYOUT_CATALOG_PROMPT.split("\n").find((line) =>
				line.startsWith(`- ${name}:`),
			),
		)
		.filter((line): line is string => Boolean(line));
	return {
		components: [...LAYOUT_CATALOG_COMPONENTS],
		componentDefinitions,
		actions: [...LAYOUT_CATALOG_ACTIONS],
		schema: LAYOUT_CATALOG_JSON_SCHEMA,
		rules: [
			"Every spec has root and elements; every element has type, props, and children.",
			"Use only the returned component and action names.",
			"Put runtime values in data and bind them with $state JSON pointers instead of duplicating them in props.",
			"Every child key and named-slot key must resolve to an element.",
			"Use repeat for state-backed arrays and keep on, visible, repeat, and slots beside props rather than inside it.",
			"Call ui.validate_layout({ layoutSpec }) before ui.create_view({ layoutSpec, data, ... }).",
		],
	};
}

function normalizeUiViewInput(input: unknown): UiViewInput {
	const record = recordFrom(input);
	if (!record) throw new Error("ui.create_view expects an object input.");
	return {
		appId: optionalString(record.appId),
		appName: optionalString(record.appName),
		appSlug: optionalString(record.appSlug),
		data: record.data,
		layoutId: optionalString(record.layoutId),
		layoutSpec: record.layoutSpec,
		logoUrl: optionalString(record.logoUrl),
		summary: optionalString(record.summary),
		title: optionalString(record.title),
		visualKind: normalizeUiVisualKind(record.visualKind),
	};
}

function normalizeUiMcpAppInput(input: unknown): UiMcpAppInput {
	const record = recordFrom(input);
	if (!record) throw new Error("ui.create_mcp_app expects an object input.");
	const title = optionalString(record.title);
	const summary = optionalString(record.summary);
	const html = typeof record.html === "string" ? record.html.trim() : "";
	if (!title) throw new Error("ui.create_mcp_app requires a title.");
	if (!summary) {
		throw new Error(
			"ui.create_mcp_app requires a meaningful plain-text summary fallback.",
		);
	}
	if (!html) throw new Error("ui.create_mcp_app requires HTML content.");
	if (html.length > GENERATED_MCP_APP_HTML_CHAR_CAP) {
		throw new Error(
			`ui.create_mcp_app HTML exceeds the ${GENERATED_MCP_APP_HTML_CHAR_CAP.toLocaleString()} character transient limit; shorten the HTML or express the view as a catalog layoutSpec with ui.create_view().`,
		);
	}
	const data = record.data === undefined ? undefined : recordFrom(record.data);
	if (record.data !== undefined && !data) {
		throw new Error(
			"ui.create_mcp_app data must be a JSON object when provided.",
		);
	}
	return {
		appId: optionalString(record.appId),
		appName: optionalString(record.appName),
		appSlug: optionalString(record.appSlug),
		...(data ? { data } : {}),
		html,
		logoUrl: optionalString(record.logoUrl),
		summary,
		title,
	};
}

function normalizeUiHealthSweepInput(input: unknown): UiHealthSweepInput {
	const record = recordFrom(input);
	if (!record)
		throw new Error("ui.create_health_sweep expects an object input.");
	const checks = recordArrayFrom(record.checks);
	if (!checks || checks.length === 0) {
		throw new Error("ui.create_health_sweep requires at least one check row.");
	}
	return {
		appName: optionalString(record.appName),
		appSlug: optionalString(record.appSlug),
		checks,
		summary: optionalString(record.summary),
		title: optionalString(record.title),
	};
}

function createCodeModeHealthSweep(
	serverCtx: ServerContext,
	input: UiHealthSweepInput,
): Record<string, unknown> {
	const checks = input.checks.map(normalizeHealthSweepCheck);
	const counts = checks.reduce<Record<HealthSweepStatus, number>>(
		(acc, check) => {
			acc[check.status] = (acc[check.status] ?? 0) + 1;
			return acc;
		},
		{ blocked: 0, error: 0, missing: 0, ok: 0, unknown: 0, warning: 0 },
	);
	const attention = checks.length - counts.ok;
	const summary =
		input.summary ??
		`${checks.length} checks: ${counts.ok} OK, ${attention} need attention.`;
	const stats = [
		{ label: "Total", value: checks.length, format: "number" },
		{ label: "OK", value: counts.ok, format: "number", tone: "success" },
		{
			label: "Attention",
			value: attention,
			format: "number",
			tone: attention > 0 ? "warning" : "success",
		},
		{
			label: "Errors",
			value: counts.error + counts.blocked + counts.missing,
			format: "number",
			tone:
				counts.error + counts.blocked + counts.missing > 0
					? "danger"
					: "default",
		},
	];

	return createCodeModeUiView(serverCtx, {
		appName: input.appName ?? "Tedix Unified",
		appSlug: input.appSlug ?? "tedix-unified",
		data: {
			checks,
			stats,
			_view: { tableStats: stats },
		},
		layoutId: "mcp-health-sweep",
		layoutSpec: buildHealthSweepLayoutSpec(
			input.title ?? "MCP health sweep",
			summary,
			checks,
		),
		summary,
		title: input.title ?? "MCP health sweep",
	});
}

function createCodeModeMcpApp(
	serverCtx: ServerContext,
	input: UiMcpAppInput,
): Record<string, unknown> {
	const app = normalizeUiViewApp(serverCtx, input);
	const resourceUri = `ui://widgets/mcp-app/${app.slug}/r/generated-app.html`;
	return {
		...input.data,
		title: input.title,
		summary: input.summary,
		generatedMcpApp: {
			html: input.html,
			renderMode: "sandboxed-html-css",
		},
		app,
		_meta: {
			"openai/outputTemplate": resourceUri,
			ui: {
				app,
				resourceUri,
			},
		},
	};
}

function normalizeHealthSweepCheck(
	check: Record<string, unknown>,
): NormalizedHealthSweepCheck {
	const namespace =
		optionalString(check.namespace) ??
		optionalString(check.provider) ??
		optionalString(check.app) ??
		"unknown";
	const tool = optionalString(check.tool) ?? optionalString(check.name);
	const status = normalizeHealthStatus(check.status);
	const latencyMs =
		typeof check.latencyMs === "number" && Number.isFinite(check.latencyMs)
			? Math.max(0, Math.trunc(check.latencyMs))
			: undefined;
	return {
		namespace,
		...(tool ? { tool } : {}),
		label:
			optionalString(check.label) ??
			(tool ? `${namespace}.${tool}` : namespace),
		status,
		...(optionalString(check.summary)
			? { summary: optionalString(check.summary) }
			: {}),
		...(optionalString(check.error)
			? { error: optionalString(check.error) }
			: {}),
		...(latencyMs !== undefined ? { latencyMs } : {}),
		tone: statusTone(status),
	};
}

function normalizeHealthStatus(value: unknown): HealthSweepStatus {
	const raw =
		typeof value === "string" && value.trim()
			? value.trim().toLowerCase()
			: "unknown";
	if (/^(ok|pass|passed|success|healthy|available|working)$/.test(raw))
		return "ok";
	if (/^(warn|warning|degraded|partial|slow|limited)$/.test(raw))
		return "warning";
	if (/^(blocked|auth|unauthenticated|unauthorized|forbidden)$/.test(raw))
		return "blocked";
	if (/^(missing|not_found|not-found|unavailable|absent)$/.test(raw))
		return "missing";
	if (/^(error|failed|failure|broken|invalid|timeout)$/.test(raw))
		return "error";
	return "unknown";
}

function buildHealthSweepLayoutSpec(
	title: string,
	summary: string,
	checks: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children: ["title", "summary", "stats", "checks"],
			},
			title: {
				type: "Text",
				props: { text: title, variant: "default" },
				children: [],
			},
			summary: {
				type: "Text",
				props: { text: summary, variant: "muted" },
				children: [],
			},
			stats: {
				type: "StatGrid",
				props: {
					stats: { $state: "/stats" },
					columns: { mobile: 2, tablet: 4, desktop: 4 },
					variant: "minimal",
					density: "compact",
				},
				children: [],
			},
			checks: {
				type: "DataTable",
				props: {
					columns: selectTableColumns(checks),
					data: { $state: "/checks" },
					pageSize: 12,
					striped: true,
					compact: true,
				},
				children: [],
			},
		},
	};
}

function createCodeModeUiView(
	serverCtx: ServerContext,
	input: UiViewInput,
): Record<string, unknown> {
	// Bare record arrays are part of the public contract and normalize under
	// `rows`, one of the keys layout inference recognizes. Any other scalar or
	// non-object data still throws because it cannot provide stable bindings.
	const recordArray =
		Array.isArray(input.data) && input.data.every(isRecord) ? input.data : null;
	const data = recordArray ? { rows: recordArray } : recordFrom(input.data);
	if (!data) {
		throw new Error(
			"ui.create_view requires data to be a JSON object or an array of records",
		);
	}

	const inferFallback = () =>
		inferJsonRenderLayout(data, {
			summary: input.summary,
			title: input.title,
			visualKind: input.visualKind ?? "auto",
		});
	const explicitLayoutSpec =
		input.layoutSpec === undefined ? null : recordFrom(input.layoutSpec);
	const explicitValidation = explicitLayoutSpec
		? normalizeJsonRenderLayoutSpec(explicitLayoutSpec)
		: null;
	const inferred: InferredLayout =
		explicitValidation?.valid && explicitValidation.layoutSpec
			? { layoutSpec: explicitValidation.layoutSpec }
			: inferFallback();
	let validation = normalizeJsonRenderLayoutSpec(inferred.layoutSpec);
	let layoutSpec = validation.layoutSpec;
	if (!validation.valid || !layoutSpec) {
		const summaryValidation = normalizeJsonRenderLayoutSpec(
			buildSummaryLayoutSpec(
				input.title ?? "Generated view",
				input.summary,
				data,
			),
		);
		validation = summaryValidation;
		layoutSpec = summaryValidation.layoutSpec;
	}
	if (!validation.valid || !layoutSpec) {
		throw new Error(
			`Invalid json-render layoutSpec: ${validation.issues.join("; ")}`,
		);
	}

	const outputData: Record<string, unknown> = inferred.viewData
		? {
				...data,
				_view: {
					...recordFrom(data._view),
					...inferred.viewData,
				},
			}
		: data;
	const app = normalizeUiViewApp(serverCtx, input);
	const layoutId = normalizeUiLayoutId(
		input.layoutId ?? input.title ?? "generated view",
	);
	const resourceUri = `ui://widgets/mcp-app/${app.slug}/r/${layoutId}.html`;
	const title = input.title ?? input.summary ?? `${app.name} view`;
	const existingMeta = recordFrom(outputData._meta) ?? {};

	return {
		...outputData,
		title,
		...(input.summary ? { summary: input.summary } : {}),
		layoutSpec,
		app,
		_meta: {
			...existingMeta,
			"openai/outputTemplate": resourceUri,
			ui: {
				...recordFrom(existingMeta.ui),
				app,
				resourceUri,
			},
		},
	};
}

function inferJsonRenderLayout(
	data: Record<string, unknown>,
	options: {
		summary?: string;
		title?: string;
		visualKind: UiVisualKind;
	},
): InferredLayout {
	const title = options.title ?? "Generated view";
	const table = findPrimaryTableCandidate(data);
	const timeline = findTimelineCandidate(data, table);
	const chart = findChartCandidate(table, options.visualKind);

	if (options.visualKind === "comparison") {
		return table
			? buildComparisonLayout(title, options.summary, table)
			: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "timeline") {
		return timeline
			? buildTimelineLayout(title, options.summary, timeline)
			: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "stats") {
		return buildStatsLayout(title, options.summary, data);
	}
	if (
		options.visualKind === "chart" ||
		options.visualKind === "timeSeries" ||
		options.visualKind === "categoricalCounts" ||
		options.visualKind === "rankedMetrics"
	) {
		return chart
			? buildChartLayout(title, options.summary, chart)
			: table
				? buildTableLayout(title, options.summary, table, data)
				: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "details" || options.visualKind === "summary") {
		return { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}
	if (options.visualKind === "table") {
		return table
			? buildTableLayout(title, options.summary, table, data)
			: { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
	}

	if (table) {
		if (isComparisonCandidate(table.rows)) {
			return buildComparisonLayout(title, options.summary, table);
		}
		if (chart?.variant === "line" || chart?.variant === "area") {
			return buildChartLayout(title, options.summary, chart);
		}
		const stats = extractDashboardStats(data, table);
		if (shouldUseDashboardLayout(data, table, stats, timeline)) {
			return buildDashboardLayout(
				title,
				options.summary,
				table,
				stats,
				timeline,
			);
		}
		const bars = buildBarListItems(table.rows);
		if (bars.length >= 3) {
			return buildRankingLayout(title, options.summary, table, bars);
		}
		if (isTimelineCandidate(table.rows)) {
			return buildTimelineLayout(title, options.summary, table);
		}
		return buildTableLayout(title, options.summary, table, data);
	}

	const stats = extractStatItems(data);
	if (stats.length >= 2) {
		return buildStatsLayout(title, options.summary, data);
	}

	return { layoutSpec: buildSummaryLayoutSpec(title, options.summary, data) };
}

function findPrimaryTableCandidate(
	data: Record<string, unknown>,
): TableCandidate | null {
	const preferred = [
		"items",
		"results",
		"products",
		"listings",
		"deployments",
		"providers",
		"sources",
		"checks",
		"findings",
		"apps",
		"namespaces",
		"workflows",
		"tasks",
		"events",
		"tools",
		"rows",
		"records",
		"list",
		"data",
	];
	for (const key of preferred) {
		const direct = recordArrayFrom(data[key]);
		if (direct) return { path: `/${key}`, rows: direct };
	}
	return findRecordArray(data);
}

function findRecordArray(
	value: unknown,
	path: string[] = [],
	depth = 0,
): TableCandidate | null {
	if (depth > 3) return null;
	const rows = recordArrayFrom(value);
	if (rows) return { path: `/${path.join("/")}`, rows };
	const record = recordFrom(value);
	if (!record) return null;
	for (const [key, nested] of Object.entries(record)) {
		if (isNonTableArrayKey(key)) continue;
		const candidate = findRecordArray(nested, [...path, key], depth + 1);
		if (candidate) return candidate;
	}
	return null;
}

function findTimelineCandidate(
	data: Record<string, unknown>,
	primaryTable: TableCandidate | null,
): TableCandidate | null {
	const preferred = [
		"timeline",
		"events",
		"activity",
		"history",
		"steps",
		"logs",
		"evidence",
		"runs",
	];
	for (const key of preferred) {
		const rows = recordArrayFrom(data[key]);
		if (rows && isTimelineCandidate(rows)) {
			return { path: `/${key}`, rows };
		}
	}
	if (primaryTable && isTimelineCandidate(primaryTable.rows))
		return primaryTable;
	return null;
}

function isNonTableArrayKey(key: string): boolean {
	return /^(stats|metrics|kpis|summaryStats|tableStats|comparisonItems|timelineItems|barItems|chartData)$/i.test(
		key,
	);
}

function recordArrayFrom(value: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(value)) return null;
	const rows = value.filter(recordFrom);
	return rows.length > 0 ? rows : null;
}

function buildTableLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	data: Record<string, unknown>,
): InferredLayout {
	const stats = extractDashboardStats(data, table).slice(0, 8);
	if (stats.length < 2) {
		return { layoutSpec: buildTableLayoutSpec(title, summary, table, false) };
	}
	return {
		viewData: { tableStats: stats },
		layoutSpec: buildTableLayoutSpec(title, summary, table, true),
	};
}

function buildDashboardLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	stats: Array<Record<string, unknown>>,
	timeline: TableCandidate | null,
): InferredLayout {
	const viewData: Record<string, unknown> = {
		dashboardStats: stats.slice(0, 8),
	};
	const children = [
		"title",
		...(summary ? ["summary"] : []),
		...(stats.length >= 2 ? ["stats"] : []),
		"table",
		...(timeline ? ["timeline"] : []),
	];
	if (timeline) {
		viewData.timelineItems = timeline.rows
			.slice(0, 12)
			.map((row, index) => normalizeTimelineItem(row, index));
	}
	return {
		viewData,
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children,
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				...(stats.length >= 2
					? {
							stats: {
								type: "StatGrid",
								props: {
									stats: { $state: "/_view/dashboardStats" },
									columns: { mobile: 2, tablet: 4, desktop: 4 },
									variant: "minimal",
									density: "compact",
								},
								children: [],
							},
						}
					: {}),
				table: {
					type: "DataTable",
					props: {
						columns: selectTableColumns(table.rows),
						data: { $state: table.path },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
				...(timeline
					? {
							timeline: {
								type: "StatusTimeline",
								props: {
									items: { $state: "/_view/timelineItems" },
									title: "Activity",
									density: "compact",
									showConnectors: true,
									variant: "plain",
								},
								children: [],
							},
						}
					: {}),
			},
		},
	};
}

function buildRankingLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	bars: Array<Record<string, unknown>>,
): InferredLayout {
	return {
		viewData: { barItems: bars.slice(0, 12) },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: ["title", ...(summary ? ["summary"] : []), "bars", "table"],
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				bars: {
					type: "BarList",
					props: {
						items: { $state: "/_view/barItems" },
						showValues: true,
						sort: "desc",
						limit: 12,
						variant: "plain",
					},
					children: [],
				},
				table: {
					type: "DataTable",
					props: {
						columns: selectTableColumns(table.rows),
						data: { $state: table.path },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
			},
		},
	};
}

function findChartCandidate(
	table: TableCandidate | null,
	visualKind: UiVisualKind,
): ChartCandidate | null {
	if (!table) return null;
	if (visualKind === "timeSeries") return findTimeSeriesChartCandidate(table);
	if (visualKind === "categoricalCounts") {
		return findCategoricalChartCandidate(table);
	}
	if (visualKind === "rankedMetrics")
		return findRankedMetricChartCandidate(table);
	return (
		findTimeSeriesChartCandidate(table) ??
		(visualKind === "chart"
			? (findCategoricalChartCandidate(table) ??
				findRankedMetricChartCandidate(table))
			: null)
	);
}

function findTimeSeriesChartCandidate(
	table: TableCandidate,
): ChartCandidate | null {
	const xKey = findTimeKey(table.rows);
	if (!xKey) return null;
	const yKeys = findNumericChartKeys(table.rows, xKey).slice(0, 4);
	if (yKeys.length === 0) return null;
	const data = table.rows
		.flatMap((row) => {
			const point: Record<string, unknown> = {
				[xKey]: stringifyChartLabel(row[xKey]),
			};
			for (const key of yKeys) {
				const numeric = numericChartValue(row[key]);
				if (numeric !== null) point[key] = numeric;
			}
			return Object.keys(point).length > 1 ? [point] : [];
		})
		.sort((left, right) => {
			const leftTime = Date.parse(String(left[xKey] ?? ""));
			const rightTime = Date.parse(String(right[xKey] ?? ""));
			if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
			return leftTime - rightTime;
		})
		.slice(0, 120);
	if (data.length < 2) return null;
	return {
		table,
		data,
		variant: yKeys.length > 2 ? "area" : "line",
		xKey,
		yKeys,
		series: yKeys.map((key, index) => ({
			key,
			label: humanizeSlug(key),
			color: chartColorToken(index),
		})),
	};
}

function findCategoricalChartCandidate(
	table: TableCandidate,
): ChartCandidate | null {
	const categoryKey = findStatusKey(table.rows) ?? findCategoryKey(table.rows);
	if (!categoryKey) return null;
	const countKey = findCountMetricKey(table.rows, categoryKey);
	const data = countKey
		? table.rows
				.flatMap((row) => {
					const label = stringifyChartLabel(row[categoryKey]);
					const value = numericChartValue(row[countKey]);
					return label && value !== null ? [{ label, value }] : [];
				})
				.sort((left, right) => Number(right.value) - Number(left.value))
		: deriveCategoryCounts(table.rows, categoryKey);
	if (data.length < 2) return null;
	return {
		table,
		data: data.slice(0, 20),
		variant: "bar",
		xKey: "label",
		yKeys: ["value"],
		nameKey: "label",
		valueKey: "value",
		series: [
			{
				key: "value",
				label: humanizeSlug(countKey ?? "count"),
				color: "chart-1",
			},
		],
	};
}

function findRankedMetricChartCandidate(
	table: TableCandidate,
): ChartCandidate | null {
	const labelKey = findLabelKey(table.rows);
	const metricKey = findRankingMetricKey(table.rows);
	if (!labelKey || !metricKey) return null;
	const data = table.rows
		.flatMap((row) => {
			const label = stringifyChartLabel(row[labelKey]);
			const value = numericChartValue(row[metricKey]);
			return label && value !== null ? [{ label, value }] : [];
		})
		.sort((left, right) => Number(right.value) - Number(left.value))
		.slice(0, 20);
	if (data.length < 2) return null;
	return {
		table,
		data,
		variant: "bar",
		xKey: "label",
		yKeys: ["value"],
		series: [
			{ key: "value", label: humanizeSlug(metricKey), color: "chart-1" },
		],
	};
}

function buildChartLayout(
	title: string,
	summary: string | undefined,
	chart: ChartCandidate,
): InferredLayout {
	return {
		viewData: { chartData: chart.data },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: [
						"title",
						...(summary ? ["summary"] : []),
						"chart",
						"table",
					],
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				chart: {
					type: "DataChart",
					props: {
						data: { $state: "/_view/chartData" },
						variant: chart.variant,
						...(chart.xKey ? { xKey: chart.xKey } : {}),
						...(chart.yKeys ? { yKeys: chart.yKeys } : {}),
						...(chart.series ? { series: chart.series } : {}),
						...(chart.nameKey ? { nameKey: chart.nameKey } : {}),
						...(chart.valueKey ? { valueKey: chart.valueKey } : {}),
						height: 260,
						showLegend: (chart.series?.length ?? 0) > 1,
						showTooltip: true,
						stacked: false,
					},
					children: [],
				},
				table: {
					type: "DataTable",
					props: {
						columns: selectTableColumns(chart.table.rows),
						data: { $state: chart.table.path },
						pageSize: 10,
						striped: true,
						compact: true,
					},
					children: [],
				},
			},
		},
	};
}

function findTimeKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(date|time|timestamp|day|week|month|period|createdAt|updatedAt|created|updated)$/i.test(
				key,
			),
		) ?? null
	);
}

function findNumericChartKeys(
	rows: Record<string, unknown>[],
	excludeKey: string,
): string[] {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return keys.filter(
		(key) =>
			key !== excludeKey &&
			rows.some((row) => numericChartValue(row[key]) !== null),
	);
}

function findCategoryKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(category|type|kind|provider|source|app|tool|namespace|label|name)$/i.test(
				key,
			),
		) ?? null
	);
}

function findCountMetricKey(
	rows: Record<string, unknown>[],
	excludeKey: string,
): string | null {
	return (
		findNumericChartKeys(rows, excludeKey).find((key) =>
			/(count|total|calls|usage|value|score|amount|tokens|cost|errors|failures|successes)$/i.test(
				key,
			),
		) ?? null
	);
}

function deriveCategoryCounts(
	rows: Record<string, unknown>[],
	categoryKey: string,
): Array<Record<string, unknown>> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const label = stringifyChartLabel(row[categoryKey]);
		if (!label) continue;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.map(([label, value]) => ({ label, value }))
		.sort((left, right) => Number(right.value) - Number(left.value));
}

function numericChartValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") return parseNumericString(value);
	return null;
}

function stringifyChartLabel(value: unknown): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return "";
}

function chartColorToken(
	index: number,
): "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5" | "chart-6" {
	return `chart-${(index % 6) + 1}` as
		| "chart-1"
		| "chart-2"
		| "chart-3"
		| "chart-4"
		| "chart-5"
		| "chart-6";
}

function buildTableLayoutSpec(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
	includeStats = false,
): Record<string, unknown> {
	const columns = selectTableColumns(table.rows);
	const children = [
		"title",
		...(summary ? ["summary"] : []),
		...(includeStats ? ["stats"] : []),
		"table",
	];
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children,
			},
			title: {
				type: "Text",
				props: { text: title, variant: "default" },
				children: [],
			},
			...(summary
				? {
						summary: {
							type: "Text",
							props: { text: summary, variant: "muted" },
							children: [],
						},
					}
				: {}),
			...(includeStats
				? {
						stats: {
							type: "StatGrid",
							props: {
								stats: { $state: "/_view/tableStats" },
								columns: { mobile: 2, tablet: 4, desktop: 4 },
								variant: "minimal",
								density: "compact",
							},
							children: [],
						},
					}
				: {}),
			table: {
				type: "DataTable",
				props: {
					columns,
					data: { $state: table.path },
					pageSize: 10,
					striped: true,
					compact: true,
				},
				children: [],
			},
		},
	};
}

function buildSummaryLayoutSpec(
	title: string,
	summary: string | undefined,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const summaryItems = Object.entries(data)
		.filter((entry): entry is [string, string | number | boolean | null] =>
			isUiScalar(entry[1]),
		)
		.slice(0, 12)
		.map(([key, value]) => ({
			label: humanizeSlug(key),
			value: stringifyUiScalar(value),
		}));
	const description = summary ?? "Structured response summary";
	return {
		root: "shell",
		elements: {
			shell: {
				type: "Stack",
				props: { gap: 3 },
				children:
					summaryItems.length > 0
						? ["title", "summary", "facts"]
						: ["title", "summary"],
			},
			title: {
				type: "Text",
				props: { text: title, variant: "default" },
				children: [],
			},
			summary: {
				type: "Text",
				props: { text: description, variant: "muted" },
				children: [],
			},
			...(summaryItems.length > 0
				? {
						facts: {
							type: "KeyValuePanel",
							props: {
								items: summaryItems,
								columns: 2,
								density: "compact",
								variant: "plain",
							},
							children: [],
						},
					}
				: {}),
		},
	};
}

function buildComparisonLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
): InferredLayout {
	const items = table.rows
		.slice(0, 24)
		.map((row, index) => normalizeComparisonItem(row, index));
	return {
		viewData: { comparisonItems: items },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: summary
						? ["title", "summary", "comparison"]
						: ["title", "comparison"],
				},
				title: {
					type: "Text",
					props: { text: title, variant: "default" },
					children: [],
				},
				...(summary
					? {
							summary: {
								type: "Text",
								props: { text: summary, variant: "muted" },
								children: [],
							},
						}
					: {}),
				comparison: {
					type: "ComparisonLayout",
					props: {
						results: { $state: "/_view/comparisonItems" },
						query: title,
						currency: inferCurrency(table.rows) ?? "USD",
						vertical: "ecommerce",
						sortBy: "price",
						hideFilters: false,
						allowFullscreen: true,
					},
					children: [],
				},
			},
		},
	};
}

function buildTimelineLayout(
	title: string,
	summary: string | undefined,
	table: TableCandidate,
): InferredLayout {
	const items = table.rows
		.slice(0, 24)
		.map((row, index) => normalizeTimelineItem(row, index));
	return {
		viewData: { timelineItems: items },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: ["timeline"],
				},
				timeline: {
					type: "StatusTimeline",
					props: {
						items: { $state: "/_view/timelineItems" },
						title,
						...(summary ? { description: summary } : {}),
						density: "compact",
						showConnectors: true,
						variant: "plain",
					},
					children: [],
				},
			},
		},
	};
}

function buildStatsLayout(
	title: string,
	summary: string | undefined,
	data: Record<string, unknown>,
): InferredLayout {
	const stats = extractStatItems(data).slice(0, 8);
	if (stats.length === 0) {
		return { layoutSpec: buildSummaryLayoutSpec(title, summary, data) };
	}
	return {
		viewData: { stats },
		layoutSpec: {
			root: "shell",
			elements: {
				shell: {
					type: "Stack",
					props: { gap: 3 },
					children: ["stats"],
				},
				stats: {
					type: "StatGrid",
					props: {
						stats: { $state: "/_view/stats" },
						title,
						...(summary ? { description: summary } : {}),
						columns: { mobile: 2, tablet: 4, desktop: 4 },
						variant: "minimal",
						density: "compact",
					},
					children: [],
				},
			},
		},
	};
}

function isComparisonCandidate(rows: Record<string, unknown>[]): boolean {
	return rows.some((row) => {
		const keys = Object.keys(row).map((key) => key.toLowerCase());
		const hasName =
			keys.some((key) =>
				/^(title|name|product|productname|model|label)$/.test(key),
			) || typeof row.id === "string";
		const hasCommerceSignal = keys.some((key) =>
			/(price|offer|merchant|seller|rating|image|thumbnail|url|link|shop|store)/.test(
				key,
			),
		);
		return hasName && hasCommerceSignal;
	});
}

function isTimelineCandidate(rows: Record<string, unknown>[]): boolean {
	return rows.some((row) => {
		const keys = Object.keys(row).map((key) => key.toLowerCase());
		const hasState = keys.some((key) =>
			/(status|state|stage|phase|step|result|outcome)/.test(key),
		);
		const hasTime = keys.some((key) =>
			/(date|time|timestamp|created|updated|started|finished|completed|scheduled)/.test(
				key,
			),
		);
		const hasEventSignal = keys.some((key) =>
			/(event|message|description|reason|step|tool|operation)/.test(key),
		);
		return hasTime || (hasState && hasEventSignal);
	});
}

function normalizeComparisonItem(
	row: Record<string, unknown>,
	index: number,
): Record<string, unknown> {
	const title =
		firstString(row, [
			"title",
			"name",
			"productName",
			"product",
			"model",
			"label",
			"id",
		]) ?? `Result ${index + 1}`;
	const subtitle =
		firstString(row, [
			"subtitle",
			"merchant",
			"merchantName",
			"seller",
			"sellerName",
			"brand",
			"source",
		]) ?? comparisonSubtitleFromRow(row);
	const image = firstString(row, [
		"image",
		"imageUrl",
		"image_url",
		"thumbnail",
		"thumbnailUrl",
		"thumbnail_url",
	]);
	const url = firstString(row, [
		"url",
		"link",
		"href",
		"productUrl",
		"product_url",
	]);
	const price = normalizePrice(row);
	const rating = normalizeRating(row);
	const offers = normalizeOffers(row);
	const seller = normalizeSeller(row);
	return {
		id: firstString(row, ["id", "sku", "asin", "slug"]) ?? `item-${index + 1}`,
		title,
		...(subtitle ? { subtitle } : {}),
		...(firstString(row, ["description", "summary"])
			? {
					description: firstString(row, ["description", "summary"]),
				}
			: {}),
		...(image ? { image } : {}),
		...(url ? { url } : {}),
		...(price ? { price } : {}),
		...(rating ? { rating } : {}),
		...(offers.length > 0 ? { offers, offerCount: offers.length } : {}),
		...(seller ? { seller } : {}),
		metadata: row,
	};
}

function comparisonSubtitleFromRow(
	row: Record<string, unknown>,
): string | undefined {
	const parts = [
		firstString(row, ["chip", "cpu", "processor"]),
		firstString(row, ["memory", "ram"]),
		firstString(row, ["storage", "ssd", "disk"]),
		firstString(row, ["color", "colour"]),
		firstString(row, ["keyboard", "layout"]),
	].filter((part): part is string => Boolean(part));
	if (parts.length === 0) return undefined;
	return parts.slice(0, 4).join(" · ");
}

function normalizeTimelineItem(
	row: Record<string, unknown>,
	index: number,
): Record<string, unknown> {
	const rawStatus = firstString(row, [
		"status",
		"state",
		"stage",
		"phase",
		"result",
		"outcome",
	]);
	const status = normalizeTimelineStatus(rawStatus);
	const title =
		firstString(row, ["title", "name", "label", "id", "tool", "step"]) ??
		`Event ${index + 1}`;
	const description = firstString(row, [
		"description",
		"message",
		"summary",
		"error",
		"reason",
	]);
	const timestamp = firstString(row, [
		"timestamp",
		"createdAt",
		"updatedAt",
		"startedAt",
		"finishedAt",
		"completedAt",
		"date",
		"time",
	]);
	return {
		title,
		...(description ? { description } : {}),
		...(timestamp ? { timestamp } : {}),
		status,
		...(rawStatus ? { statusLabel: humanizeSlug(rawStatus) } : {}),
		metadata: row,
	};
}

function extractStatItems(
	data: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const direct = recordArrayFrom(data.stats);
	if (direct) {
		return direct
			.map((stat) => normalizeStatItem(stat))
			.filter((stat): stat is Record<string, unknown> => Boolean(stat));
	}
	return Object.entries(data)
		.filter(([, value]) => typeof value === "number" || isNumericString(value))
		.map(([key, value]) => ({
			label: humanizeSlug(key),
			value: typeof value === "number" ? value : String(value),
			format: inferStatFormat(key, value),
			tone: inferStatTone(key),
		}));
}

function extractDashboardStats(
	data: Record<string, unknown>,
	table: TableCandidate | null,
): Array<Record<string, unknown>> {
	const explicit = extractStatItems(data);
	if (explicit.length >= 2) return explicit;
	if (!table) return explicit;
	const derived = deriveTableStats(table.rows);
	return derived.length >= 2 ? derived : explicit;
}

function shouldUseDashboardLayout(
	data: Record<string, unknown>,
	table: TableCandidate,
	stats: Array<Record<string, unknown>>,
	timeline: TableCandidate | null,
): boolean {
	if (timeline && timeline.path !== table.path) return true;
	if (recordArrayFrom(data.stats) && stats.length >= 2) return true;
	if (stats.length >= 2 && findStatusKey(table.rows)) return true;
	return false;
}

function deriveTableStats(
	rows: Record<string, unknown>[],
): Array<Record<string, unknown>> {
	const statusKey = findStatusKey(rows);
	if (!statusKey)
		return rows.length > 1 ? [{ label: "Total", value: rows.length }] : [];
	const counts = new Map<string, number>();
	for (const row of rows) {
		const value = row[statusKey];
		const label =
			typeof value === "string" && value.trim()
				? value.trim()
				: typeof value === "boolean"
					? String(value)
					: value === null || value === undefined
						? "Unknown"
						: String(value);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [
		{ label: "Total", value: rows.length, tone: "default", format: "number" },
		...Array.from(counts.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 7)
			.map(([label, value]) => ({
				label: humanizeSlug(label),
				value,
				format: "number",
				tone: statusTone(label),
				badge: label,
				badgeVariant: statusBadgeVariant(label),
			})),
	];
}

function findStatusKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(status|state|stage|phase|result|outcome|health|severity)$/i.test(key),
		) ?? null
	);
}

function buildBarListItems(
	rows: Record<string, unknown>[],
): Array<Record<string, unknown>> {
	const labelKey = findLabelKey(rows);
	const metricKey = findRankingMetricKey(rows);
	if (!labelKey || !metricKey) return [];
	return rows
		.flatMap((row) => {
			const label = row[labelKey];
			const value = row[metricKey];
			const numeric =
				typeof value === "number"
					? value
					: typeof value === "string"
						? parseNumericString(value)
						: null;
			if (typeof label !== "string" || !label.trim() || numeric === null) {
				return [];
			}
			return [
				{
					label: label.trim(),
					value: numeric,
					valueLabel: stringifyUiScalar(value as string | number),
					description: firstString(row, [
						"description",
						"summary",
						"subtitle",
						"provider",
						"source",
					]),
					tone: inferStatTone(label),
				},
			];
		})
		.sort((a, b) => Number(b.value) - Number(a.value));
}

function findLabelKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	return (
		keys.find((key) =>
			/^(name|title|label|provider|source|app|tool|namespace)$/i.test(key),
		) ??
		keys.find((key) => rows.some((row) => typeof row[key] === "string")) ??
		null
	);
}

function findRankingMetricKey(rows: Record<string, unknown>[]): string | null {
	const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
	const numericKeys = keys.filter((key) =>
		rows.some(
			(row) => typeof row[key] === "number" || isNumericString(row[key]),
		),
	);
	return (
		numericKeys.find((key) =>
			/(score|rank|count|total|value|amount|usage|calls|tokens|cost|errors|failures|successes|latency|duration|progress|percent|rate)$/i.test(
				key,
			),
		) ?? null
	);
}

function normalizeStatItem(
	stat: Record<string, unknown>,
): Record<string, unknown> | null {
	const label = firstString(stat, ["label", "name", "title", "key"]);
	const value = stat.value ?? stat.count ?? stat.total ?? stat.amount;
	if (!label || !isUiScalar(value)) return null;
	return {
		label,
		value: typeof value === "boolean" ? String(value) : value,
		...(firstString(stat, ["unit"])
			? { unit: firstString(stat, ["unit"]) }
			: {}),
		...(firstString(stat, ["description", "summary"])
			? { description: firstString(stat, ["description", "summary"]) }
			: {}),
		format: inferStatFormat(label, value),
		tone: inferStatTone(label),
	};
}

function normalizePrice(
	row: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const value =
		row.price ??
		row.priceEUR ??
		row.priceUsd ??
		row.priceUSD ??
		row.priceText ??
		row.priceDisplay ??
		row.amount ??
		row.cost ??
		row.total ??
		row.lowestPrice;
	const explicitCurrency = firstString(row, ["currency", "priceCurrency"]);
	const currency =
		explicitCurrency ??
		(row.priceEUR !== undefined
			? "EUR"
			: row.priceUsd !== undefined || row.priceUSD !== undefined
				? "USD"
				: undefined) ??
		(typeof value === "string" ? inferCurrencyFromText(value) : undefined) ??
		"USD";
	if (isRecord(value) && typeof value.amount === "number") {
		return {
			amount: value.amount,
			currency: firstString(value, ["currency"]) ?? currency,
			...(typeof value.original === "number"
				? { original: value.original }
				: {}),
			...(firstString(value, ["formatted"])
				? {
						formatted: firstString(value, ["formatted"]),
					}
				: {}),
		};
	}
	if (typeof value === "number") {
		return {
			amount: value,
			currency,
			...(firstString(row, ["priceDisplay", "priceText", "formattedPrice"])
				? {
						formatted: firstString(row, [
							"priceDisplay",
							"priceText",
							"formattedPrice",
						]),
					}
				: {}),
		};
	}
	if (typeof value === "string") {
		const amount = parseNumericString(value);
		if (typeof amount === "number") {
			return {
				amount,
				currency: inferCurrencyFromText(value) ?? currency,
				formatted: value,
			};
		}
	}
	return undefined;
}

function normalizeRating(
	row: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const value = row.rating ?? row.score;
	if (isRecord(value) && typeof value.value === "number") {
		return {
			value: value.value,
			...(typeof value.count === "number" ? { count: value.count } : {}),
			...(typeof value.max === "number" ? { max: value.max } : {}),
		};
	}
	if (typeof value === "number") return { value, max: value > 5 ? 100 : 5 };
	return undefined;
}

function normalizeOffers(
	row: Record<string, unknown>,
): Record<string, unknown>[] {
	const offers = Array.isArray(row.offers) ? row.offers.filter(recordFrom) : [];
	return offers.flatMap((offer, index) => {
		const price = offer.price;
		const amount =
			typeof price === "number"
				? price
				: typeof price === "string"
					? parseNumericString(price)
					: null;
		if (typeof amount !== "number") return [];
		const merchantName =
			firstString(offer, ["merchantName", "merchant", "seller", "store"]) ??
			`Offer ${index + 1}`;
		return {
			merchantName,
			price: amount,
			currency:
				firstString(offer, ["currency"]) ??
				inferCurrencyFromText(typeof price === "string" ? price : "") ??
				firstString(row, ["currency"]) ??
				"USD",
			...(firstString(offer, ["merchantId"])
				? {
						merchantId: firstString(offer, ["merchantId"]),
					}
				: {}),
			...(firstString(offer, ["url", "link", "href"])
				? {
						url: firstString(offer, ["url", "link", "href"]),
					}
				: {}),
		};
	});
}

function normalizeSeller(
	row: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const name = firstString(row, [
		"sellerName",
		"seller",
		"merchant",
		"merchantName",
	]);
	if (!name) return undefined;
	return {
		name,
		...(firstString(row, ["sellerId", "merchantId"])
			? {
					id: firstString(row, ["sellerId", "merchantId"]),
				}
			: {}),
	};
}

function selectTableColumns(
	rows: Record<string, unknown>[],
): Array<{ field: string; header: string; format: string; sortable: boolean }> {
	const keys = Array.from(
		new Set(
			rows
				.flatMap((row) => Object.keys(row))
				.filter((key) => rows.some((row) => isUiScalar(row[key]))),
		),
	);
	return keys.slice(0, 6).map((key) => ({
		field: key,
		header: humanizeSlug(key),
		format: inferColumnFormat(key, rows),
		sortable: true,
	}));
}

function inferColumnFormat(
	key: string,
	rows: Record<string, unknown>[],
): "badge" | "date" | "number" | "text" {
	const lowerKey = key.toLowerCase();
	if (/(status|state|stage|type|priority|severity|enabled)/.test(lowerKey)) {
		return "badge";
	}
	if (/(date|time|created|updated|timestamp)/.test(lowerKey)) return "date";
	if (rows.some((row) => typeof row[key] === "number")) return "number";
	return "text";
}

function isUiScalar(value: unknown): value is string | number | boolean | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function stringifyUiScalar(value: string | number | boolean | null): string {
	if (value === null) return "—";
	return String(value);
}

function firstString(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isNumericString(value: unknown): value is string {
	return typeof value === "string" && parseNumericString(value) !== null;
}

function parseNumericString(value: string): number | null {
	const normalized = value
		.trim()
		.replace(/[^\d,.-]/g, "")
		.replace(/,(?=\d{3}\b)/g, "")
		.replace(",", ".");
	if (!normalized) return null;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

function inferCurrency(rows: Record<string, unknown>[]): string | undefined {
	for (const row of rows) {
		const explicit = firstString(row, ["currency", "priceCurrency"]);
		if (explicit) return explicit;
		if (row.priceEUR !== undefined) return "EUR";
		if (row.priceUsd !== undefined || row.priceUSD !== undefined) return "USD";
		const price = row.price;
		if (isRecord(price)) {
			const currency = firstString(price, ["currency"]);
			if (currency) return currency;
		}
		if (typeof price === "string") {
			const currency = inferCurrencyFromText(price);
			if (currency) return currency;
		}
		for (const key of ["priceText", "priceDisplay", "formattedPrice"]) {
			const currency = inferCurrencyFromText(firstString(row, [key]) ?? "");
			if (currency) return currency;
		}
	}
	return undefined;
}

function inferCurrencyFromText(value: string): string | undefined {
	if (value.includes("€")) return "EUR";
	if (value.includes("£")) return "GBP";
	if (value.includes("$")) return "USD";
	return undefined;
}

function normalizeTimelineStatus(value: string | undefined): string {
	const normalized = value?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
	if (
		/^(ok|done|success|succeeded|complete|completed|passed|healthy|published)$/.test(
			normalized,
		)
	) {
		return "completed";
	}
	if (
		/^(active|current|running|processing|inprogress|live)$/.test(normalized)
	) {
		return "current";
	}
	if (/^(pending|queued|waiting|scheduled|todo|draft)$/.test(normalized)) {
		return "pending";
	}
	if (/^(warn|warning|degraded|partial)$/.test(normalized)) {
		return "warning";
	}
	if (
		/^(error|failed|failure|blocked|unhealthy|rejected)$/.test(normalized) ||
		normalized.includes("blocked")
	) {
		return "error";
	}
	return "info";
}

function inferStatFormat(key: string, value: unknown): string {
	const lower = key.toLowerCase();
	if (/(rate|ratio|percent|percentage)/.test(lower)) return "percent";
	if (
		/(price|amount|revenue|cost|spend)/.test(lower) &&
		typeof value === "number"
	) {
		return "currency";
	}
	return typeof value === "number" || isNumericString(value)
		? "number"
		: "text";
}

function inferStatTone(key: string): string {
	const lower = key.toLowerCase();
	if (
		/(success|passed|healthy|complete|completed|active|published)/.test(lower)
	) {
		return "success";
	}
	if (/(warn|warning|pending|queued|waiting)/.test(lower)) return "warning";
	if (/(error|failed|failure|blocked|unhealthy|rejected)/.test(lower)) {
		return "danger";
	}
	return "default";
}

function statusBadgeVariant(value: string): string {
	const normalized = normalizeTimelineStatus(value);
	if (normalized === "completed") return "success";
	if (normalized === "warning" || normalized === "pending") return "warning";
	if (normalized === "error") return "destructive";
	return "secondary";
}

function statusTone(value: string): string {
	const normalized = normalizeTimelineStatus(value);
	if (normalized === "completed") return "success";
	if (normalized === "warning" || normalized === "pending") return "warning";
	if (normalized === "error") return "danger";
	if (normalized === "info" || normalized === "current") return "info";
	return "default";
}

function normalizeJsonRenderLayoutSpec(input: unknown): {
	valid: boolean;
	issues: string[];
	layoutSpec?: Record<string, unknown>;
} {
	const spec = recordFrom(input);
	if (!spec || !isNonEmptySpec(spec as never)) {
		return {
			valid: false,
			issues: ["layoutSpec must be a non-empty json-render object."],
		};
	}

	const initial = validateSpec(spec as never);
	if (initial.valid) {
		return { valid: true, issues: [], layoutSpec: spec };
	}

	const { spec: fixed } = autoFixSpec(spec as never);
	const fixedRecord = recordFrom(fixed);
	const recheck = validateSpec(fixed as never);
	if (fixedRecord && recheck.valid) {
		return { valid: true, issues: [], layoutSpec: fixedRecord };
	}

	return {
		valid: false,
		issues: readJsonRenderIssues(initial.issues ?? recheck.issues),
	};
}

function readJsonRenderIssues(issues: unknown): string[] {
	if (!Array.isArray(issues)) return ["Unknown json-render validation error."];
	const messages = issues
		.map((issue) => {
			const record = recordFrom(issue);
			return typeof record?.message === "string" ? record.message : null;
		})
		.filter((message): message is string => Boolean(message));
	return messages.length > 0
		? messages.slice(0, 8)
		: ["Unknown json-render validation error."];
}

function normalizeUiViewApp(
	serverCtx: ServerContext,
	input: UiViewInput,
): { id: string; slug: string; name: string; logoUrl?: string } {
	const slug = isWidgetAppSlug(input.appSlug)
		? input.appSlug
		: serverCtx.appSlug;
	const name =
		input.appName ??
		(slug === serverCtx.appSlug
			? (serverCtx.app?.name ?? humanizeSlug(slug))
			: humanizeSlug(slug));
	const logoUrl =
		input.logoUrl ??
		(slug === serverCtx.appSlug ? serverCtx.app?.logoUrl : undefined);
	return {
		id: input.appId ?? (slug === serverCtx.appSlug ? serverCtx.appId : slug),
		slug,
		name,
		...(logoUrl ? { logoUrl } : {}),
	};
}

function normalizeUiLayoutId(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/^\/?r\//, "")
		.replace(/\.html$/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 72);
	return normalized || "generated-view";
}

function optionalString(value: unknown): string | undefined {
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed ? trimmed : undefined;
}

function normalizeUiVisualKind(value: unknown): UiVisualKind | undefined {
	return value === "auto" ||
		value === "categoricalCounts" ||
		value === "chart" ||
		value === "comparison" ||
		value === "details" ||
		value === "rankedMetrics" ||
		value === "stats" ||
		value === "summary" ||
		value === "table" ||
		value === "timeSeries" ||
		value === "timeline"
		? value
		: undefined;
}
