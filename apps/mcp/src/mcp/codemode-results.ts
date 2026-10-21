import {
	type CodeModeTruncationOptions,
	buildCodeModeResultHandle,
	serializeCodeModeResultForHandle,
	shapeBoundedCodeModeResult,
} from "@tedix/tedi-codemode-core/bounded-result";
import { type CatalogDiscoveryResult } from "./codemode-discovery";
import { type CodeModeResultStore } from "./codemode-result-store";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	type OwnedReadObservation,
	parseDocsFileObservationReceipt,
	READ_OBSERVATION_META_KEY,
	READ_OBSERVATIONS_META_KEY,
	type OwnedConnectedCollectionRead,
	parseConnectedCollectionRead,
	READ_COLLECTION_META_KEY,
	READ_COLLECTIONS_META_KEY,
} from "@tedix/mcp-shared/read-observation-receipt";
import { type ServerContext, type AppTool } from "./server-context";
import {
	resolveToolWidgetRoute,
	getToolLayoutSpec,
} from "./utils/render-widget";
import { recordFrom, humanizeSlug } from "./codemode-ui";
import { resolveWidgetAppSlug } from "./utils/widget-app";
import {
	type TedixPaymentRequiredMeta,
	getPaymentRequiredMeta,
	X402_PAYMENT_META_KEY,
} from "@tedix/mcp-shared/payment";

/**
 * Bound the model-facing `code` result without silent type degradation. An
 * oversized structured result becomes a `__tedix_truncated` envelope (see
 * `@tedix/tedi-codemode-core/bounded-result`) instead of a bare clipped JSON
 * string that downstream parsers mistake for an empty/real string. Within
 * budget the value passes through byte-identical. Exported for tests.
 */
export function shapeCodeModeResultForModel(
	result: unknown,
	options?: CodeModeTruncationOptions,
): unknown {
	return shapeBoundedCodeModeResult(serializeCodeModeResult(result), options);
}

/**
 * Like {@link shapeCodeModeResultForModel}, but an over-budget result is kept
 * whole in `store` and replaced by a `__tedix_result_handle` envelope the
 * caller pages through `discover.read_result`. Falls back to the truncation
 * envelope when there is no store or the write fails, so nothing new can make
 * a `code` call error. Within budget the value passes through untouched.
 */
export async function shapeCodeModeResultWithHandle(
	result: unknown,
	input: {
		store: CodeModeResultStore | null;
		executionId: string;
		options?: CodeModeTruncationOptions;
	},
): Promise<unknown> {
	const value = serializeCodeModeResult(result);
	const shaped = shapeBoundedCodeModeResult(value, input.options);
	if (Object.is(shaped, value) || !input.store) return shaped;
	try {
		const serialized = serializeCodeModeResultForHandle(value);
		const { expiresAt } = await input.store.put(input.executionId, serialized);
		return buildCodeModeResultHandle(
			value,
			serialized,
			{ handle: input.executionId, expiresAt },
			input.options,
		);
	} catch (error) {
		console.warn(
			"[MCP] Code Mode result handle store failed; returning truncation envelope:",
			error instanceof Error ? error.message : String(error),
		);
		return shaped;
	}
}

/**
 * Per-app override for the model-facing result token budget (D1
 * `mcpConfig.codeModeResultMaxTokens`). `undefined` means the default budget.
 */
export function resolveCodeModeResultBudget(
	serverCtx: Pick<ServerContext, "appMetadata">,
): CodeModeTruncationOptions | undefined {
	const mcpConfig = serverCtx.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const configured = mcpConfig?.codeModeResultMaxTokens;
	return typeof configured === "number" &&
		Number.isFinite(configured) &&
		configured > 0
		? { maxTokens: configured }
		: undefined;
}

export function serializeCodeModeResult(result: unknown): unknown {
	if (!isCatalogDiscoveryResult(result)) return result;
	// Model-facing single shape: `results` + `meta` only. The sandbox value
	// additionally carries the per-namespace convenience map
	// (`r.namespaces.firecrawl_tedix.firecrawl_scrape`) — useful for code, but
	// on the wire it would serialize every tool 2-3x. Sandbox compatibility is
	// untouched; only what the model re-reads every turn is deduped.
	return {
		results: result.results,
		meta: result.meta,
	};
}

function isCatalogDiscoveryResult(
	result: unknown,
): result is CatalogDiscoveryResult {
	if (!isRecord(result) || Array.isArray(result)) return false;
	return (
		Array.isArray(result.results) &&
		isRecord(result.namespaces) &&
		isRecord(result.meta)
	);
}

export function stripUpstreamCodeFailurePrefix(error: string): string {
	return error.startsWith("Code execution failed: ")
		? error.slice("Code execution failed: ".length)
		: error;
}

export function collectCodeModeReadObservation(input: {
	meta: unknown;
	executionId: string | undefined;
	innerCallOrdinal: number;
	into: OwnedReadObservation[];
}): void {
	if (!input.executionId || input.into.length >= 100) return;
	const meta =
		input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
			? (input.meta as Record<string, unknown>)
			: null;
	const receipt = parseDocsFileObservationReceipt(
		meta?.[READ_OBSERVATION_META_KEY],
	);
	if (!receipt) return;
	input.into.push({
		innerCallId: `${input.executionId}:${input.innerCallOrdinal}`,
		receipt,
	});
}

export function codeModeReadObservationMeta(
	readObservations: readonly OwnedReadObservation[],
): Record<string, unknown> {
	return readObservations.length > 0
		? { [READ_OBSERVATIONS_META_KEY]: readObservations }
		: {};
}

export function collectCodeModeCollectionRead(input: {
	meta: unknown;
	executionId: string | undefined;
	innerCallOrdinal: number;
	into: OwnedConnectedCollectionRead[];
}): void {
	if (!input.executionId || input.into.length >= 100) return;
	const meta =
		input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
			? (input.meta as Record<string, unknown>)
			: null;
	const observation = parseConnectedCollectionRead(
		meta?.[READ_COLLECTION_META_KEY],
	);
	if (!observation) return;
	input.into.push({
		innerCallId: `${input.executionId}:${input.innerCallOrdinal}`,
		observation,
	});
}

export function codeModeCollectionReadMeta(
	collectionReads: readonly OwnedConnectedCollectionRead[],
): Record<string, unknown> {
	return collectionReads.length > 0
		? { [READ_COLLECTIONS_META_KEY]: collectionReads }
		: {};
}

export function attachCodeModeReadObservations<T extends object>(
	result: T,
	readObservations: readonly OwnedReadObservation[],
	collectionReads: readonly OwnedConnectedCollectionRead[] = [],
): T {
	if (readObservations.length === 0 && collectionReads.length === 0)
		return result;
	return {
		...result,
		_meta: {
			...(result as { _meta?: Record<string, unknown> })._meta,
			...codeModeReadObservationMeta(readObservations),
			...codeModeCollectionReadMeta(collectionReads),
		},
	} as T;
}

function buildCodeModeWidgetMetadata(
	serverCtx: ServerContext,
	tool: AppTool,
	dynamicLayoutSpec?: Record<string, unknown>,
): Record<string, unknown> | null {
	const resolvedWidgetRoute = resolveToolWidgetRoute(tool);
	const widgetRoute = (resolvedWidgetRoute ?? tool.widgetRoute)?.replace(
		/^\//,
		"",
	);
	if (!widgetRoute) return null;

	const widgetApp = resolveCodeModeWidgetApp(serverCtx, tool);
	const layoutSpec = dynamicLayoutSpec ?? getToolLayoutSpec(tool);
	const resourceUri = `ui://widgets/mcp-app/${widgetApp.slug}/${widgetRoute}.html`;
	const outputTemplate =
		serverCtx.toolOutputTemplates.get(tool.toolId) ??
		tool.outputTemplate ??
		undefined;

	return {
		...(layoutSpec ? { layoutSpec } : {}),
		app: {
			id: widgetApp.id,
			slug: widgetApp.slug,
			name: widgetApp.name,
			...(widgetApp.logoUrl ? { logoUrl: widgetApp.logoUrl } : {}),
		},
		_meta: {
			...(outputTemplate ? { "openai/outputTemplate": outputTemplate } : {}),
			"openai/widgetAccessible": tool.widgetAccessible ?? true,
			ui: {
				resourceUri,
				toolPrefix: tool.toolId.includes("__")
					? tool.toolId.slice(0, tool.toolId.lastIndexOf("__") + 2)
					: "",
				app: {
					id: widgetApp.id,
					slug: widgetApp.slug,
					name: widgetApp.name,
					...(widgetApp.logoUrl ? { logoUrl: widgetApp.logoUrl } : {}),
				},
			},
		},
	};
}

function resolveCodeModeWidgetApp(
	serverCtx: ServerContext,
	tool: AppTool,
): { id: string; slug: string; name: string; logoUrl?: string } {
	const config = recordFrom(tool.config);
	const sourceAppId =
		typeof config?._sourceAppId === "string" ? config._sourceAppId : undefined;
	const sourceLogoUrl =
		typeof config?._sourceAppLogoUrl === "string"
			? config._sourceAppLogoUrl
			: undefined;
	const slug = resolveWidgetAppSlug(serverCtx, tool);

	return {
		id: sourceAppId ?? (slug === serverCtx.appSlug ? serverCtx.appId : slug),
		slug,
		name:
			slug === serverCtx.appSlug
				? (serverCtx.app?.name ?? humanizeSlug(slug))
				: humanizeSlug(slug),
		...(sourceLogoUrl
			? { logoUrl: sourceLogoUrl }
			: slug === serverCtx.appSlug && serverCtx.app?.logoUrl
				? { logoUrl: serverCtx.app.logoUrl }
				: {}),
	};
}

export function attachCodeModeWidgetMetadata(
	data: Record<string, unknown>,
	serverCtx: ServerContext,
	tool: AppTool,
	dynamicLayoutSpec?: Record<string, unknown>,
): Record<string, unknown> {
	const widgetMetadata = buildCodeModeWidgetMetadata(
		serverCtx,
		tool,
		dynamicLayoutSpec,
	);
	if (!widgetMetadata) return data;

	const existingMeta = recordFrom(data._meta) ?? {};
	const widgetMeta = recordFrom(widgetMetadata._meta) ?? {};

	return {
		...data,
		...widgetMetadata,
		_meta: {
			...existingMeta,
			...widgetMeta,
		},
	};
}

export function codeModeResultMeta(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): Record<string, unknown> | undefined {
	if (depth > 5 || value == null || seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = codeModeResultMeta(item, depth + 1, seen);
			if (nested) return nested;
		}
		return undefined;
	}

	const result = recordFrom(value);
	if (!result) return undefined;
	const meta = recordFrom(result?._meta);
	const ui = recordFrom(meta?.ui);
	const resourceUri =
		typeof ui?.resourceUri === "string" ? ui.resourceUri : null;
	if (resourceUri?.startsWith("ui://widgets/")) {
		return {
			...meta,
			// Keep complete widget data outside the model-facing result budget.
			"tedix/widgetData": result,
			ui: {
				...ui,
				resourceUri,
			},
		};
	}

	for (const key of [
		"view",
		"widget",
		"result",
		"data",
		"response",
		"output",
		"structuredContent",
	]) {
		const nested = codeModeResultMeta(result[key], depth + 1, seen);
		if (nested) return nested;
	}

	return undefined;
}

export function findPaymentRequiredMeta(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): TedixPaymentRequiredMeta | null {
	if (depth > 6) return null;
	const direct = getPaymentRequiredMeta({ result: value });
	if (direct) return direct;
	if (!isRecord(value) && !Array.isArray(value)) return null;
	if (seen.has(value)) return null;
	seen.add(value);

	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = findPaymentRequiredMeta(item, depth + 1, seen);
			if (nested) return nested;
		}
		return null;
	}

	for (const nestedValue of Object.values(value)) {
		const nested = findPaymentRequiredMeta(nestedValue, depth + 1, seen);
		if (nested) return nested;
	}
	return null;
}

export function buildPaymentExtra(
	extra: { _meta?: Record<string, unknown> } | undefined,
	payment: unknown,
): { _meta?: Record<string, unknown> } | undefined {
	const meta = isRecord(extra?._meta)
		? { ...(extra._meta as Record<string, unknown>) }
		: {};
	if (payment !== undefined && meta[X402_PAYMENT_META_KEY] === undefined) {
		meta[X402_PAYMENT_META_KEY] = payment;
	}
	return Object.keys(meta).length > 0 ? { _meta: meta } : undefined;
}
