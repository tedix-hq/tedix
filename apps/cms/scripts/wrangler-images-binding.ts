/**
 * Structured inspection of a Worker's Cloudflare Images binding.
 *
 * A `wrangler.jsonc` (the tenant starters) is JSONC with trailing commas, and
 * its named environments do NOT inherit top-level bindings, so a regex over the
 * raw text can decide neither question; it is parsed with `jsonc-parser` and
 * every scope is reported separately. A `cloudflare.config.ts` (cms-runtime)
 * selects bindings by `mode`, so it is evaluated once per deploy mode and each
 * mode is reported as its own scope.
 */

import {
	type ParseError,
	parse as parseJsonc,
	printParseErrorCode,
} from "jsonc-parser";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** One config scope: the top level, a named environment, or a cf mode. */
export type ImagesBindingScope = {
	/** True when this scope declares the requested Images binding name. */
	declared: boolean;
	/** The binding names this scope declares under `images`, for diagnostics. */
	declaredBindings: string[];
	/** `top-level`, `env.<name>`, or `mode.<name>`. */
	scope: string;
};

export type ImagesBindingReport = {
	/** True when at least one scope declares the binding. */
	declaredAnywhere: boolean;
	/** True when every scope declares the binding (and there is at least one). */
	declaredEverywhere: boolean;
	/** JSONC parse failures. Non-empty means neither flag above can be trusted. */
	parseErrors: string[];
	/** Scopes that did NOT declare the binding, for failure detail. */
	missingScopes: string[];
	scopes: ImagesBindingScope[];
};

/**
 * Wrangler accepts `images: { binding: "NAME" }`. Read every binding name a
 * scope declares so a renamed binding surfaces as a diagnostic instead of a
 * bare `false`.
 */
function bindingNamesIn(value: unknown): string[] {
	const entries = Array.isArray(value) ? value : [value];
	const names: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const binding = entry.binding;
		if (typeof binding === "string" && binding.length > 0) names.push(binding);
	}
	return names;
}

function scopeFor(
	scope: string,
	config: Record<string, unknown>,
	bindingName: string,
): ImagesBindingScope {
	const declaredBindings = bindingNamesIn(config.images);
	return {
		declared: declaredBindings.includes(bindingName),
		declaredBindings,
		scope,
	};
}

/**
 * Inspect every scope of a `wrangler.jsonc` source for an Images binding.
 *
 * @param source Raw `wrangler.jsonc` text.
 * @param bindingName Binding name to look for. Default `IMAGES`.
 */
export function inspectImagesBinding(
	source: string,
	bindingName = "IMAGES",
): ImagesBindingReport {
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(source, errors, {
		allowEmptyContent: false,
		allowTrailingComma: true,
		disallowComments: false,
	});
	const parseErrors = errors.map(
		(error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`,
	);

	if (!isRecord(parsed)) {
		return {
			declaredAnywhere: false,
			declaredEverywhere: false,
			missingScopes: [],
			parseErrors:
				parseErrors.length > 0
					? parseErrors
					: ["wrangler config did not parse to an object"],
			scopes: [],
		};
	}

	const scopes: ImagesBindingScope[] = [
		scopeFor("top-level", parsed, bindingName),
	];
	const envs = parsed.env;
	if (isRecord(envs)) {
		for (const name of Object.keys(envs).sort()) {
			const envConfig = envs[name];
			if (!isRecord(envConfig)) continue;
			scopes.push(scopeFor(`env.${name}`, envConfig, bindingName));
		}
	}

	const missingScopes = scopes
		.filter((scope) => !scope.declared)
		.map((scope) => scope.scope);

	return {
		declaredAnywhere: scopes.some((scope) => scope.declared),
		declaredEverywhere: scopes.length > 0 && missingScopes.length === 0,
		missingScopes,
		parseErrors,
		scopes,
	};
}

/** A `cloudflare.config.ts` Worker, resolved for one mode. */
export type CloudflareConfigWorker = {
	name?: string;
	compatibilityFlags?: string[];
	triggers?: Array<Record<string, unknown>>;
	exports?: Record<string, Record<string, unknown>>;
	env?: Record<string, Record<string, unknown>>;
};

/** Modes a `cloudflare.config.ts` is deployed or developed in. */
export const CLOUDFLARE_CONFIG_MODES = ["development", "production"] as const;

/**
 * Resolve a `cloudflare.config.ts` default export for one mode. The config
 * imports `cf/config`, which resolves from the config's own workspace.
 */
export async function loadCloudflareConfigWorker(
	configPath: string,
	mode: string,
): Promise<CloudflareConfigWorker> {
	const module = (await import(pathToFileURL(resolve(configPath)).href)) as {
		default: unknown;
	};
	const config =
		typeof module.default === "function"
			? await (
					module.default as (context: {
						mode: string;
						isPreview: boolean;
					}) => unknown
				)({ mode, isPreview: false })
			: module.default;
	const worker = isRecord(config) ? config.worker : undefined;
	if (!isRecord(worker))
		throw new Error(`${configPath} declares no worker for mode "${mode}"`);
	return worker as CloudflareConfigWorker;
}

/**
 * Inspect every mode of a `cloudflare.config.ts` for an Images binding
 * (`bindings.images()` under the requested name).
 */
export async function inspectCloudflareConfigImagesBinding(
	configPath: string,
	bindingName = "IMAGES",
): Promise<ImagesBindingReport> {
	const scopes: ImagesBindingScope[] = [];
	const parseErrors: string[] = [];
	for (const mode of CLOUDFLARE_CONFIG_MODES) {
		try {
			const env =
				(await loadCloudflareConfigWorker(configPath, mode)).env ?? {};
			const declaredBindings = Object.entries(env)
				.filter(([, binding]) => binding.type === "images")
				.map(([name]) => name);
			scopes.push({
				declared: declaredBindings.includes(bindingName),
				declaredBindings,
				scope: `mode.${mode}`,
			});
		} catch (error) {
			parseErrors.push(
				`mode ${mode}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const missingScopes = scopes
		.filter((scope) => !scope.declared)
		.map((scope) => scope.scope);
	return {
		declaredAnywhere: scopes.some((scope) => scope.declared),
		declaredEverywhere:
			parseErrors.length === 0 &&
			scopes.length > 0 &&
			missingScopes.length === 0,
		missingScopes,
		parseErrors,
		scopes,
	};
}
