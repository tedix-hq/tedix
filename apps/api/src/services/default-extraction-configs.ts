/** Validates D1 extraction instructions and resolves limit/mapping defaults. */
import type { Vertical } from "@tedix/api-contract/schemas/app";
import {
	ExtractionConfigExpandedSchema,
	type ExtractionConfigExpanded,
} from "@tedix/api-contract/schemas/extraction-config";
import { VERTICAL_FIELD_MAPPINGS } from "./field-mapping-config";

export type ResolvedExtractionConfig = ExtractionConfigExpanded &
	Required<Pick<ExtractionConfigExpanded, "limit">>;
const VERTICAL_LIMITS: Record<Vertical, number> = {
	automotive: 50,
	marketplace: 30,
	ecommerce: 30,
	real_estate: 30,
	jobs: 30,
	services: 30,
	crypto: 50,
	travel: 30,
	content: 30,
};

export function getExtractionConfig(
	vertical: Vertical,
	options?: {
		limit?: number;
		appOverrides?: Partial<ResolvedExtractionConfig>;
	},
): ResolvedExtractionConfig {
	const { limit, appOverrides } = options ?? {};
	// ⚠️ PROMPT-ONLY MODE: Validate all required fields
	if (!appOverrides?.prompt) {
		throw new Error(
			`[Config Error] No extraction prompt in D1. ` +
				`Set apps.metadata.extractionConfig.prompt. Vertical: ${vertical}. ` +
				`See docs/platform/api.md for setup guide.`,
		);
	}

	if (!appOverrides?.schema) {
		throw new Error(
			`[Config Error] No extraction schema in D1. ` +
				`Set apps.metadata.extractionConfig.schema. Vertical: ${vertical}.`,
		);
	}

	if (!appOverrides?.arrayKey) {
		throw new Error(
			`[Config Error] No arrayKey in D1. ` +
				`Set apps.metadata.extractionConfig.arrayKey. Vertical: ${vertical}.`,
		);
	}

	if (!appOverrides?.siteName) {
		throw new Error(
			`[Config Error] No siteName in D1. ` +
				`Prompt-only mode requires site name (e.g., "mobile.de Germany"). ` +
				`Set apps.metadata.extractionConfig.siteName. Vertical: ${vertical}.`,
		);
	}

	if (!appOverrides?.siteSearchInstructions) {
		throw new Error(
			`[Config Error] No siteSearchInstructions in D1. ` +
				`Prompt-only mode requires navigation instructions. ` +
				`Set apps.metadata.extractionConfig.siteSearchInstructions. Vertical: ${vertical}.`,
		);
	}

	const config = ExtractionConfigExpandedSchema.parse({
		method: "agent",
		...appOverrides,
	});
	return {
		...config,
		limit:
			config.limit ??
			limit ??
			VERTICAL_LIMITS[vertical] ??
			VERTICAL_LIMITS.ecommerce,
		fieldMappings:
			config.fieldMappings ??
			VERTICAL_FIELD_MAPPINGS[vertical] ??
			VERTICAL_FIELD_MAPPINGS.automotive,
	};
}
