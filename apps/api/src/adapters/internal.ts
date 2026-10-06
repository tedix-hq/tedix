/**
 * Internal Adapter
 *
 * Internal adapter for calling Tedix API endpoints (oRPC or REST) through the
 * standard adapter lifecycle. This keeps Tedix dogfooding on the same adapter
 * execution path while avoiding generic external API glue config.
 *
 * @module @tedix/api/adapters/internal
 */

import { isUnsafePathSegment } from "@tedix/api-contract/schemas/adapter-bindings";
import { callRpc } from "@tedix/api-client/internal";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import type {
	AppAdapter,
	InternalAdapterConfig,
} from "@tedix/db/schema/adapters";
import { isInternalConfig } from "@tedix/db/schema/adapters";
import {
	type AdapterContext,
	type AdapterResult,
	BaseAdapter,
	type SearchOptions,
} from "./base";

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_LIMIT = 20;
type FieldMappings = Record<string, string>;

function getByPath(obj: unknown, path: string): unknown {
	if (!obj || typeof obj !== "object" || !path) return undefined;
	const segments = path
		.replace(/\[(\d+)\]/g, ".$1")
		.split(".")
		.filter(Boolean);

	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined) return undefined;
		if (typeof current !== "object") return undefined;
		if (/^\d+$/.test(segment)) {
			if (!Array.isArray(current)) return undefined;
			current = current[Number.parseInt(segment, 10)];
		} else {
			current = (current as Record<string, unknown>)[segment];
		}
	}
	return current;
}

function setByPath(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	if (!path || value === undefined || value === null) return;
	const segments = path.split(".").filter(Boolean);
	if (segments.some(isUnsafePathSegment)) return;
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!segment) continue;
		if (!(segment in current) || typeof current[segment] !== "object") {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	const lastSegment = segments[segments.length - 1];
	if (lastSegment) current[lastSegment] = value;
}

export class InternalAdapter extends BaseAdapter {
	readonly name = "internal";
	readonly description = "Tedix internal API integration (RPC/REST)";
	readonly supportedMarkets: string[] = [];

	private readonly internalConfig: InternalAdapterConfig;
	private readonly fieldMappings: FieldMappings;

	constructor(adapterConfig: AppAdapter) {
		super(adapterConfig);
		if (!isInternalConfig(adapterConfig.config)) {
			throw new Error("Invalid internal adapter configuration");
		}
		this.internalConfig = adapterConfig.config;
		this.fieldMappings = (adapterConfig.fieldMappings as FieldMappings) ?? {};
	}

	async search(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();
		const endpoint = this.normalizeEndpoint(this.internalConfig.endpoint);
		if (!endpoint) {
			return this.createErrorResult(
				"Internal adapter endpoint not configured",
				"missing_endpoint",
			);
		}

		// Prevent accidental recursive loops through listings.search itself.
		if (endpoint.includes("/listings/search")) {
			return this.createErrorResult(
				"Internal adapter endpoint cannot point to listings search (recursive)",
				"recursive_endpoint",
			);
		}

		const baseUrl = this.internalConfig.baseUrl ?? ctx.env.API_URL;
		if (!baseUrl) {
			return this.createErrorResult(
				"Internal adapter baseUrl not configured and API_URL missing",
				"missing_base_url",
			);
		}

		try {
			const params = this.buildParams(query, options);
			const transport = this.internalConfig.transport ?? "rpc";
			const headers = this.buildHeaders(ctx);
			const timeoutMs = this.internalConfig.timeout ?? DEFAULT_TIMEOUT;

			let data: Record<string, unknown>;
			if (transport === "rpc") {
				const path = endpoint.replace(/^\/+/, "").replace(/^rpc\//, "");
				const output = await callRpc<Record<string, unknown>>(path, params, {
					apiUrl: baseUrl,
					headers,
					timeoutMs,
				});
				// Preserve the adapter's configured mapping surface while oRPC owns
				// the actual transport envelope.
				data = { json: output };
			} else {
				const method = (this.internalConfig.method ?? "GET").toUpperCase();
				const url = this.joinUrl(
					baseUrl,
					endpoint.startsWith("/v1/")
						? endpoint
						: `/v1/${endpoint.replace(/^\/+/, "")}`,
				);
				if (method === "GET") {
					const withQuery = this.withQuery(url, params);
					const response = await this.makeTimedRequest(
						withQuery,
						{ method: "GET", headers },
						timeoutMs,
					);
					if (!response.ok) {
						const errorText = await response
							.text()
							.catch(() => "Unknown error");
						return this.createErrorResult(
							`Tedix API error: ${response.status} - ${errorText}`,
							`http_${response.status}`,
							Date.now() - startTime,
						);
					}
					data = (await response.json()) as Record<string, unknown>;
				} else {
					const response = await this.makeTimedRequest(
						url,
						{
							method: "POST",
							headers,
							body: JSON.stringify(params),
						},
						timeoutMs,
					);
					if (!response.ok) {
						const errorText = await response
							.text()
							.catch(() => "Unknown error");
						return this.createErrorResult(
							`Tedix API error: ${response.status} - ${errorText}`,
							`http_${response.status}`,
							Date.now() - startTime,
						);
					}
					data = (await response.json()) as Record<string, unknown>;
				}
			}
			const transportDefaultItemsPath =
				transport === "rpc" ? "json.data" : "data";
			const transportDefaultTotalPath =
				transport === "rpc" ? "json.pagination.total" : "pagination.total";
			const transportDefaultSourcePath =
				transport === "rpc" ? "json.source" : "source";

			const itemsPath =
				this.internalConfig.itemsPath ?? transportDefaultItemsPath;
			const totalPath =
				this.internalConfig.totalPath ?? transportDefaultTotalPath;
			const sourcePath =
				this.internalConfig.sourcePath ?? transportDefaultSourcePath;

			const rawItems = getByPath(data, itemsPath);
			const rawItemArray = Array.isArray(rawItems) ? rawItems : [];
			const items = rawItemArray
				.map((rawItem, index) => this.transformToLayoutItem(rawItem, index))
				.filter((item): item is LayoutItem => item !== null);

			const totalFromPath = getByPath(data, totalPath);
			const totalResults =
				typeof totalFromPath === "number" ? totalFromPath : items.length;
			const sourceFromPath = getByPath(data, sourcePath);
			const source =
				this.internalConfig.sourceLabel ??
				(typeof sourceFromPath === "string" ? sourceFromPath : this.name);

			return {
				success: true,
				items,
				source,
				totalResults,
				hasMore: totalResults > items.length,
				responseTimeMs: Date.now() - startTime,
				meta: {
					query,
					cached: false,
				},
			};
		} catch (error) {
			return this.createErrorResult(
				error instanceof Error ? error.message : "Unknown error",
				"request_failed",
				Date.now() - startTime,
			);
		}
	}

	async healthCheck(ctx: AdapterContext): Promise<{
		healthy: boolean;
		latencyMs?: number;
		error?: string;
	}> {
		const startTime = Date.now();
		const endpoint = this.normalizeEndpoint(this.internalConfig.endpoint);
		if (!endpoint) {
			return { healthy: false, error: "Endpoint not configured" };
		}

		const baseUrl = this.internalConfig.baseUrl ?? ctx.env.API_URL;
		if (!baseUrl) {
			return { healthy: false, error: "API_URL/baseUrl missing" };
		}

		try {
			const transport = this.internalConfig.transport ?? "rpc";
			const headers = this.buildHeaders(ctx);
			const timeoutMs = Math.min(
				this.internalConfig.timeout ?? DEFAULT_TIMEOUT,
				5000,
			);
			if (transport === "rpc") {
				const path = endpoint.replace(/^\/+/, "").replace(/^rpc\//, "");
				await callRpc(path, {}, { apiUrl: baseUrl, headers, timeoutMs });
				return { healthy: true, latencyMs: Date.now() - startTime };
			}

			const url = this.joinUrl(
				baseUrl,
				endpoint.startsWith("/v1/")
					? endpoint
					: `/v1/${endpoint.replace(/^\/+/, "")}`,
			);
			const response = await this.makeTimedRequest(
				url,
				{ method: "GET", headers },
				timeoutMs,
			);

			return {
				healthy: response.ok,
				latencyMs: Date.now() - startTime,
				...(response.ok ? {} : { error: `HTTP ${response.status}` }),
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - startTime,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private buildParams(
		query: string,
		options: SearchOptions,
	): Record<string, unknown> {
		const params: Record<string, unknown> = {
			...this.internalConfig.staticParams,
		};
		const paramMap = this.internalConfig.paramMap ?? {};
		const setParam = (key: string, value: unknown) => {
			if (value === undefined || value === null) return;
			const mappedKey = paramMap[key] ?? key;
			params[mappedKey] = value;
		};

		setParam("query", query);
		setParam("q", query);
		setParam(
			"limit",
			options.limit ?? this.internalConfig.limit ?? DEFAULT_LIMIT,
		);
		setParam("offset", options.offset);
		setParam("country", options.country);
		setParam("minPrice", options.minPrice);
		setParam("maxPrice", options.maxPrice);
		setParam("sort", options.sort);
		setParam("category", options.category);
		setParam("brand", options.brand);
		setParam("inStock", options.inStock);
		setParam("queries", options.queries);
		setParam("includeOffers", options.includeOffers);

		return params;
	}

	private buildHeaders(_ctx: AdapterContext): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...this.internalConfig.headers,
		};

		const auth = this.internalConfig.auth;
		const token = auth?.token;
		if (auth?.type === "bearer" && token) {
			headers.Authorization = `Bearer ${token}`;
		} else if (auth?.type === "api_key" && token) {
			const headerName = auth.headerName ?? "X-API-Key";
			headers[headerName] = token;
		}

		return headers;
	}

	private transformToLayoutItem(
		rawItem: unknown,
		index: number,
	): LayoutItem | null {
		if (!rawItem || typeof rawItem !== "object") return null;
		const raw = rawItem as Record<string, unknown>;

		if (Object.keys(this.fieldMappings).length === 0) {
			const directId = raw.id ?? raw._id ?? raw.slug ?? `${this.id}-${index}`;
			const directTitle = raw.title ?? raw.name ?? raw.label ?? null;
			if (!directTitle) return null;
			const item: LayoutItem = {
				id: String(directId),
				title: String(directTitle),
			};
			if (raw.subtitle) item.subtitle = String(raw.subtitle);
			if (raw.description) item.description = String(raw.description);
			if (raw.image) item.image = String(raw.image);
			if (raw.url) item.url = String(raw.url);
			return item;
		}

		const mapped: Record<string, unknown> = {};
		for (const [targetPath, sourcePath] of Object.entries(this.fieldMappings)) {
			const value = getByPath(raw, sourcePath);
			if (value !== undefined) {
				setByPath(mapped, targetPath, value);
			}
		}

		const id = mapped.id ?? raw.id ?? raw._id ?? `${this.id}-${index}`;
		const title = mapped.title ?? raw.title ?? raw.name ?? null;
		if (!title) return null;

		const item: LayoutItem = {
			id: String(id),
			title: String(title),
		};
		if (mapped.subtitle) item.subtitle = String(mapped.subtitle);
		if (mapped.description) item.description = String(mapped.description);
		if (mapped.image) item.image = String(mapped.image);
		if (mapped.url) item.url = String(mapped.url);

		const price = mapped.price as Record<string, unknown> | undefined;
		if (price && typeof price === "object" && price.amount !== undefined) {
			item.price = {
				amount: Number(price.amount) || 0,
				currency: String(price.currency ?? "EUR"),
				original:
					price.original !== undefined ? Number(price.original) : undefined,
				formatted:
					price.formatted !== undefined ? String(price.formatted) : undefined,
			};
		}

		return item;
	}

	private normalizeEndpoint(endpoint: string | undefined): string | null {
		if (!endpoint) return null;
		return endpoint.trim();
	}

	private joinUrl(baseUrl: string, endpoint: string): string {
		try {
			return new URL(endpoint, baseUrl).toString();
		} catch {
			return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
		}
	}

	private withQuery(url: string, params: Record<string, unknown>): string {
		const u = new URL(url);
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					u.searchParams.append(key, String(item));
				}
			} else {
				u.searchParams.set(key, String(value));
			}
		}
		return u.toString();
	}

	private async makeTimedRequest(
		url: string,
		init: RequestInit,
		timeoutMs: number,
	): Promise<Response> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timeout);
		}
	}
}
