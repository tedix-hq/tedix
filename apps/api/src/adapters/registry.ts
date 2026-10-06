/**
 * Adapter Registry
 *
 * Central registry for managing data source adapters in the unified
 * multi-tenant MCP engine. Loads adapter configurations from D1 database
 * and creates appropriate adapter instances.
 *
 * Features:
 * - Dynamic adapter loading from D1
 * - Priority-based adapter selection
 * - Parallel search across all adapters
 * - Fallback chain support
 * - Result aggregation and deduplication
 *
 * @module @tedix/api/adapters/registry
 */

import {
	getRequiredBindings,
	setByPath,
	validateBindings,
} from "@tedix/api-contract/schemas/adapter-bindings";
import type { AdapterType } from "@tedix/api-contract/schemas/adapter-bindings";
import type { DbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import { getEnabledAdapters } from "@tedix/db/queries/adapters";
import {
	fetchAppSecretsForHydration,
	fetchOrgSecretsForHydration,
	getBindingsBatch,
	getUniqueSecretIds,
} from "@tedix/db/queries/app-adapter-secret-bindings";
import type { AppAdapter } from "@tedix/db/schema/adapters";
import type { AppAdapterSecretBinding } from "@tedix/db/schema/app-adapter-secret-bindings";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import {
	decryptAppSecret,
	decryptSecret,
} from "@tedix/db/utils/secrets-encryption";

import type {
	AdapterContext,
	AdapterResult,
	BaseAdapter,
	SearchOptions,
} from "./base";
import { CustomAdapter } from "./custom";
import { KlarnaAdapter } from "./klarna";
import { McpAdapter } from "./mcp";
import { ShopifyAdapter } from "./shopify";
import { InternalAdapter } from "./internal";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

type SecretHydrationFailureStage =
	| "fetch_bindings"
	| "batch_fetch_secrets"
	| "decrypt_app_secret"
	| "decrypt_org_secret";

function logSecretHydrationFailure(
	stage: SecretHydrationFailureStage,
	error: unknown,
): void {
	console.error({
		component: "api.adapter-registry",
		event: "adapter_secret_hydration_failed",
		stage,
		exception: safeExceptionTopology(error),
	});
}

// =============================================================================
// REGISTRY TYPES
// =============================================================================

/**
 * Aggregated search result from multiple adapters
 */
export interface AggregatedResult {
	/** Whether any adapter succeeded */
	success: boolean;
	/** Merged and deduplicated items from all adapters */
	items: LayoutItem[];
	/** Total results across all adapters */
	totalResults: number;
	/** Results per adapter (for debugging/analytics) */
	adapterResults: AdapterResult[];
	/** Errors from failed adapters */
	errors: Array<{ adapter: string; error: string }>;
	/** Total response time in milliseconds */
	responseTimeMs: number;
}

/**
 * Options for registry search methods
 */
export interface RegistrySearchOptions extends SearchOptions {
	/** Only use adapters of specific types */
	adapterTypes?: string[];
	/** Skip specific adapters by ID */
	excludeAdapters?: string[];
	/** Filter to specific adapter IDs */
	includeAdapters?: string[];
	/** Stop after first successful result (for fallback chains) */
	stopOnSuccess?: boolean;
	/** Timeout for entire search operation in ms */
	timeout?: number;
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

/**
 * Create an adapter instance from configuration
 * Returns null for unsupported adapter types
 */
function createAdapter(config: AppAdapter): BaseAdapter | null {
	switch (config.adapterType) {
		case "klarna":
			return new KlarnaAdapter(config);
		case "shopify":
			return new ShopifyAdapter(config);
		case "custom":
			return new CustomAdapter(config);
		case "mcp":
			return new McpAdapter(config);
		case "internal":
			return new InternalAdapter(config);
		default:
			console.warn(`Unsupported adapter type: ${config.adapterType}`);
			return null;
	}
}

// =============================================================================
// ADAPTER REGISTRY
// =============================================================================

/**
 * Adapter Registry
 *
 * Manages data source adapters for an app. Loads configurations from D1
 * and provides methods for searching across adapters.
 *
 * @example
 * ```typescript
 * const registry = new AdapterRegistry(db, env);
 * await registry.loadAdaptersForApp("app-123");
 *
 * const result = await registry.searchAll("wireless headphones", {
 *   limit: 20,
 *   country: "DE",
 * }, ctx);
 * ```
 */
export class AdapterRegistry {
	private readonly db: DbClient;
	private readonly env: Record<string, string | undefined>;
	private adapters: Map<string, BaseAdapter> = new Map();
	private appId: string | null = null;
	private loadedAt: Date | null = null;

	constructor(db: DbClient, env: Record<string, string | undefined>) {
		this.db = db;
		this.env = env;
	}

	// =========================================================================
	// ADAPTER LOADING
	// =========================================================================

	/**
	 * Load adapters for a specific app from D1
	 * Clears any previously loaded adapters
	 *
	 * @param appId - App ID to load adapters for
	 */
	async loadAdaptersForApp(appId: string): Promise<void> {
		// Clear existing adapters
		this.adapters.clear();
		this.appId = appId;

		// Load enabled adapters from D1 (already sorted by priority)
		const adapterConfigs = await getEnabledAdapters(this.db, appId);

		// Hydrate adapter configs with decrypted secrets
		const hydratedConfigs = await this.hydrateAdapterSecrets(
			adapterConfigs,
			appId,
		);

		// Create adapter instances with hydrated configs
		for (const config of hydratedConfigs) {
			const adapter = createAdapter(config);
			if (adapter) {
				this.adapters.set(config.id, adapter);
			}
		}

		this.loadedAt = new Date();
	}

	/**
	 * Reload adapters from D1 (useful if config changed)
	 */
	async reload(): Promise<void> {
		if (this.appId) {
			await this.loadAdaptersForApp(this.appId);
		}
	}

	/**
	 * Check if adapters are loaded
	 */
	get isLoaded(): boolean {
		return this.appId !== null && this.adapters.size > 0;
	}

	/**
	 * Get count of loaded adapters
	 */
	get adapterCount(): number {
		return this.adapters.size;
	}

	/**
	 * Get list of loaded adapter names
	 */
	get adapterNames(): string[] {
		return Array.from(this.adapters.values()).map((a) => a.name);
	}

	// =========================================================================
	// SEARCH METHODS
	// =========================================================================

	/**
	 * Search across all loaded adapters in parallel
	 * Results are merged and deduplicated
	 *
	 * @param query - Search query string
	 * @param options - Search options
	 * @param ctx - Adapter context with env bindings
	 * @returns Aggregated results from all adapters
	 */
	async searchAll(
		query: string,
		options: RegistrySearchOptions,
		ctx: AdapterContext,
	): Promise<AggregatedResult> {
		const startTime = Date.now();

		if (!this.isLoaded) {
			return {
				success: false,
				items: [],
				totalResults: 0,
				adapterResults: [],
				errors: [{ adapter: "registry", error: "No adapters loaded" }],
				responseTimeMs: Date.now() - startTime,
			};
		}

		// Filter adapters based on options
		const adaptersToSearch = this.filterAdapters(options);

		if (adaptersToSearch.length === 0) {
			return {
				success: false,
				items: [],
				totalResults: 0,
				adapterResults: [],
				errors: [{ adapter: "registry", error: "No matching adapters" }],
				responseTimeMs: Date.now() - startTime,
			};
		}

		// Create search context with optional timeout
		const searchCtx = options.timeout
			? this.createTimeoutContext(ctx, options.timeout)
			: ctx;

		// Execute searches in parallel
		const searchPromises = adaptersToSearch.map(async (adapter) => {
			try {
				return await adapter.search(query, options, searchCtx);
			} catch (error) {
				return {
					success: false,
					items: [],
					source: adapter.name,
					error: error instanceof Error ? error.message : "Unknown error",
				} as AdapterResult;
			}
		});

		const results = await Promise.all(searchPromises);

		// Aggregate results
		return this.aggregateResults(results, startTime);
	}

	/**
	 * Search using only the primary (highest priority) adapter
	 *
	 * @param query - Search query string
	 * @param options - Search options
	 * @param ctx - Adapter context
	 * @returns Result from primary adapter
	 */
	async searchPrimary(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();

		const primary = this.getPrimaryAdapter();
		if (!primary) {
			return {
				success: false,
				items: [],
				source: "registry",
				error: "No primary adapter available",
				responseTimeMs: Date.now() - startTime,
			};
		}

		try {
			return await primary.search(query, options, ctx);
		} catch (error) {
			return {
				success: false,
				items: [],
				source: primary.name,
				error: error instanceof Error ? error.message : "Unknown error",
				responseTimeMs: Date.now() - startTime,
			};
		}
	}

	/**
	 * Search with fallback chain
	 * Tries each adapter in priority order until one succeeds
	 *
	 * @param query - Search query string
	 * @param options - Search options
	 * @param ctx - Adapter context
	 * @returns First successful result, or last error
	 */
	async searchWithFallback(
		query: string,
		options: SearchOptions,
		ctx: AdapterContext,
	): Promise<AdapterResult> {
		const startTime = Date.now();

		const adapters = this.getAdaptersSortedByPriority();
		if (adapters.length === 0) {
			return {
				success: false,
				items: [],
				source: "registry",
				error: "No adapters available",
				responseTimeMs: Date.now() - startTime,
			};
		}

		let lastError: AdapterResult | null = null;

		for (const adapter of adapters) {
			try {
				const result = await adapter.search(query, options, ctx);

				if (result.success && result.items.length > 0) {
					// Success! Add total time to result
					return {
						...result,
						responseTimeMs: Date.now() - startTime,
					};
				}

				// No items found, try next adapter
				lastError = result;
			} catch (error) {
				lastError = {
					success: false,
					items: [],
					source: adapter.name,
					error: error instanceof Error ? error.message : "Unknown error",
					responseTimeMs: Date.now() - startTime,
				};
			}
		}

		// All adapters failed
		return (
			lastError ?? {
				success: false,
				items: [],
				source: "registry",
				error: "All adapters failed",
				responseTimeMs: Date.now() - startTime,
			}
		);
	}

	// =========================================================================
	// ADAPTER ACCESS
	// =========================================================================

	/**
	 * Get the primary (highest priority) adapter
	 */
	getPrimaryAdapter(): BaseAdapter | null {
		const adapters = this.getAdaptersSortedByPriority();
		return adapters[0] ?? null;
	}

	/**
	 * Get an adapter by ID
	 */
	getAdapterById(id: string): BaseAdapter | null {
		return this.adapters.get(id) ?? null;
	}

	/**
	 * Get all adapters sorted by priority (descending)
	 */
	getAdaptersSortedByPriority(): BaseAdapter[] {
		return Array.from(this.adapters.values()).sort(
			(a, b) => b.priority - a.priority,
		);
	}

	/**
	 * Get adapters by type
	 */
	getAdaptersByType(type: string): BaseAdapter[] {
		return Array.from(this.adapters.values()).filter(
			(adapter) => adapter.adapterType === type,
		);
	}

	// =========================================================================
	// HEALTH CHECKS
	// =========================================================================

	/**
	 * Check health of all loaded adapters
	 *
	 * @param ctx - Adapter context
	 * @returns Health status for each adapter
	 */
	async checkHealth(ctx: AdapterContext): Promise<
		Array<{
			adapter: string;
			healthy: boolean;
			latencyMs?: number;
			error?: string;
		}>
	> {
		const results = await Promise.all(
			Array.from(this.adapters.values()).map(async (adapter) => {
				const health = await adapter.healthCheck(ctx);
				return {
					adapter: adapter.name,
					...health,
				};
			}),
		);

		return results;
	}

	// =========================================================================
	// PRIVATE HELPERS
	// =========================================================================

	/**
	 * Hydrate adapter configs with decrypted secrets from explicit bindings
	 *
	 * NEW APPROACH (explicit bindings):
	 * 1. Fetch all bindings for all adapters (1 query)
	 * 2. Collect unique secret IDs by scope (app vs org)
	 * 3. Batch fetch and decrypt secrets (2 queries: app + org)
	 * 4. Inject decrypted values into configs via dot notation paths
	 * 5. Validate required bindings and mark adapters unhealthy if missing
	 *
	 * PERFORMANCE:
	 * - Old: N queries (1 per secret per adapter)
	 * - New: 3-4 queries total (bindings + app secrets + org secrets + app lookup)
	 */
	private async hydrateAdapterSecrets(
		adapters: AppAdapter[],
		appId: string,
	): Promise<AppAdapter[]> {
		const masterKey = this.env.SECRETS_MASTER_KEY;

		// No master key = skip hydration (secrets unavailable)
		if (!masterKey) {
			console.warn(
				"[AdapterRegistry] SECRETS_MASTER_KEY not available, skipping secret hydration",
			);
			return adapters;
		}

		if (adapters.length === 0) {
			return adapters;
		}

		// STEP 1: Fetch all bindings for all adapters (1 query)
		const adapterIds = adapters.map((a) => a.id);
		let bindingsMap: Map<string, AppAdapterSecretBinding[]>;

		try {
			bindingsMap = await getBindingsBatch(this.db, adapterIds);
		} catch (error) {
			logSecretHydrationFailure("fetch_bindings", error);
			// Continue with empty map - adapters will use configs as-is
			return adapters;
		}

		// STEP 2: Collect unique secret IDs by scope
		const { appSecretIds, orgSecretIds } = await getUniqueSecretIds(
			this.db,
			adapterIds,
		);

		// STEP 3: Batch fetch and decrypt secrets
		const appSecretsMap = new Map<string, string>();
		const orgSecretsMap = new Map<string, string>();

		try {
			// Fetch app secrets
			if (appSecretIds.length > 0) {
				const appSecretsDecrypted = await this.batchDecryptAppSecrets(
					appId,
					appSecretIds,
					masterKey,
				);
				for (const [id, value] of appSecretsDecrypted) {
					appSecretsMap.set(id, value);
				}
			}

			// Fetch org secrets (need orgId from app record)
			if (orgSecretIds.length > 0) {
				const app = await getAppById(this.db, appId);
				if (app?.organizationId) {
					const orgSecretsDecrypted = await this.batchDecryptOrgSecrets(
						app.organizationId,
						orgSecretIds,
						masterKey,
					);
					for (const [id, value] of orgSecretsDecrypted) {
						orgSecretsMap.set(id, value);
					}
				}
			}
		} catch (error) {
			logSecretHydrationFailure("batch_fetch_secrets", error);
			// Continue with empty maps - individual adapters will handle missing secrets
		}

		// STEP 4: Inject decrypted values into adapter configs
		const hydratedAdapters = adapters.map((adapter) => {
			const bindings = bindingsMap.get(adapter.id) || [];

			if (bindings.length === 0) {
				// No bindings = check if adapter requires any via ADAPTER_TYPE_SPECS
				const requiredBindings = getRequiredBindings(
					adapter.adapterType as AdapterType,
				);
				if (requiredBindings.length > 0) {
					// Adapter has required bindings but none configured
					return {
						...adapter,
						config: {
							...adapter.config,
							_healthStatus: "unhealthy",
							_healthReason: `Missing required bindings: ${requiredBindings.map((b) => b.configKey).join(", ")}`,
						},
					};
				}
				// No required bindings, return as-is
				return adapter;
			}

			// Clone config for mutation
			const config = { ...adapter.config } as Record<string, unknown>;
			const hydratedBindings: Record<string, string | undefined> = {};
			const missingRequired: string[] = [];

			// Apply each binding
			for (const binding of bindings) {
				// Get decrypted secret from appropriate map
				const secretValue =
					binding.secretScope === "app"
						? appSecretsMap.get(binding.secretId)
						: orgSecretsMap.get(binding.secretId);

				if (secretValue !== undefined) {
					// Inject into config using dot notation
					setByPath(config, binding.configPath, secretValue);
					hydratedBindings[binding.configPath] = secretValue;

					if (this.env.ENVIRONMENT === "development") {
						console.log(
							`[AdapterRegistry] Hydrated binding → ${adapter.adapterType}.${binding.configPath}`,
						);
					}
				} else {
					// Check if this configPath is required
					const requiredBindings = getRequiredBindings(
						adapter.adapterType as AdapterType,
					);
					const isRequired = requiredBindings.some(
						(b) => b.configKey === binding.configPath,
					);
					if (isRequired) {
						missingRequired.push(binding.configPath);
						console.warn(
							`[AdapterRegistry] Required secret missing for binding: ${binding.configPath} (adapter ${adapter.id})`,
						);
					}
				}
			}

			// Validate using ADAPTER_TYPE_SPECS
			const validationResult = validateBindings(
				adapter.adapterType as AdapterType,
				hydratedBindings,
				{ includeWarnings: this.env.ENVIRONMENT === "development" },
			);

			if (validationResult.warnings.length > 0) {
				console.warn(
					`[AdapterRegistry] Adapter ${adapter.id} warnings:`,
					validationResult.warnings,
				);
			}

			// Mark adapter unhealthy if required secrets missing
			if (missingRequired.length > 0 || !validationResult.valid) {
				const allMissing = [
					...missingRequired,
					...validationResult.missing,
				].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

				return {
					...adapter,
					config: {
						...config,
						_healthStatus: "unhealthy",
						_healthReason: `Missing required bindings: ${allMissing.join(", ")}`,
					},
				};
			}

			return {
				...adapter,
				config,
			};
		});

		return hydratedAdapters;
	}

	/**
	 * Batch decrypt app secrets by ID
	 * Returns map: secretId → decrypted value
	 */
	private async batchDecryptAppSecrets(
		appId: string,
		secretIds: string[],
		masterKey: string,
	): Promise<Map<string, string>> {
		const secrets = await fetchAppSecretsForHydration(
			this.db,
			appId,
			secretIds,
		);

		const decryptedMap = new Map<string, string>();

		await Promise.all(
			secrets.map(async (secret) => {
				try {
					const decrypted = await decryptAppSecret(
						masterKey,
						appId,
						secret.encryptedValue,
					);
					decryptedMap.set(secret.id, decrypted);
				} catch (error) {
					logSecretHydrationFailure("decrypt_app_secret", error);
				}
			}),
		);

		return decryptedMap;
	}

	/**
	 * Batch decrypt org secrets by ID
	 * Returns map: secretId → decrypted value
	 */
	private async batchDecryptOrgSecrets(
		orgId: string,
		secretIds: string[],
		masterKey: string,
	): Promise<Map<string, string>> {
		const secrets = await fetchOrgSecretsForHydration(
			this.db,
			orgId,
			secretIds,
		);

		const decryptedMap = new Map<string, string>();

		await Promise.all(
			secrets.map(async (secret) => {
				try {
					const decrypted = await decryptSecret(
						masterKey,
						orgId,
						secret.encryptedValue,
					);
					decryptedMap.set(secret.id, decrypted);
				} catch (error) {
					logSecretHydrationFailure("decrypt_org_secret", error);
				}
			}),
		);

		return decryptedMap;
	}

	/**
	 * Filter adapters based on search options
	 */
	private filterAdapters(options: RegistrySearchOptions): BaseAdapter[] {
		let adapters = Array.from(this.adapters.values());

		// Filter by adapter types
		if (options.adapterTypes && options.adapterTypes.length > 0) {
			adapters = adapters.filter((a) =>
				options.adapterTypes!.includes(a.adapterType),
			);
		}

		// Filter to specific adapter IDs
		if (options.includeAdapters && options.includeAdapters.length > 0) {
			adapters = adapters.filter((a) =>
				options.includeAdapters!.includes(a.id),
			);
		}

		// Exclude specific adapters
		if (options.excludeAdapters && options.excludeAdapters.length > 0) {
			adapters = adapters.filter(
				(a) => !options.excludeAdapters!.includes(a.id),
			);
		}

		// Sort by priority
		return adapters.sort((a, b) => b.priority - a.priority);
	}

	/**
	 * Create a context with timeout signal
	 */
	private createTimeoutContext(
		ctx: AdapterContext,
		timeout: number,
	): AdapterContext {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), timeout);

		// Combine with existing signal if present
		if (ctx.signal) {
			ctx.signal.addEventListener("abort", () => controller.abort(), {
				once: true,
			});
		}

		return {
			...ctx,
			signal: controller.signal,
		};
	}

	/**
	 * Aggregate results from multiple adapters
	 */
	private aggregateResults(
		results: AdapterResult[],
		startTime: number,
	): AggregatedResult {
		const errors: Array<{ adapter: string; error: string }> = [];
		const allItems: LayoutItem[] = [];
		let totalResults = 0;

		for (const result of results) {
			if (result.success) {
				allItems.push(...result.items);
				totalResults += result.totalResults ?? result.items.length;
			} else if (result.error) {
				errors.push({ adapter: result.source, error: result.error });
			}
		}

		// Deduplicate by ID (keep first occurrence, which is from highest priority adapter)
		const seenIds = new Set<string>();
		const deduplicatedItems = allItems.filter((item) => {
			if (seenIds.has(item.id)) {
				return false;
			}
			seenIds.add(item.id);
			return true;
		});

		return {
			success: deduplicatedItems.length > 0 || errors.length === 0,
			items: deduplicatedItems,
			totalResults,
			adapterResults: results,
			errors,
			responseTimeMs: Date.now() - startTime,
		};
	}
}
