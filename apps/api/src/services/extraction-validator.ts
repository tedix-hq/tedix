import type { Vertical } from "@tedix/api-contract/schemas/app";
import type { ExtractedItem } from "./item-normalization";

export interface ValidationResult {
	valid: boolean;
	score: number; // 0.0 to 1.0
	warnings: string[];
	errors: string[];
	coverage: {
		expected: number;
		present: number;
		missing: string[];
	};
}

/**
 * Validate extraction results for data quality
 * Run this AFTER normalizeItems() and BEFORE toItemInsert()
 */
export function validateExtraction(
	items: ExtractedItem[],
	vertical: Vertical,
	step: "normalized" | "pre-insert",
): ValidationResult {
	const warnings: string[] = [];
	const errors: string[] = [];

	if (items.length === 0) {
		errors.push("No items extracted");
		return {
			valid: false,
			score: 0,
			warnings,
			errors,
			coverage: { expected: 0, present: 0, missing: [] },
		};
	}

	// Define critical fields per vertical
	const criticalFields = getCriticalFields(vertical);

	// Check first 3 items for field coverage
	const sampleSize = Math.min(3, items.length);
	let totalPresent = 0;
	const totalExpected = criticalFields.length * sampleSize;
	const allMissing = new Set<string>();

	for (let i = 0; i < sampleSize; i++) {
		const item = items[i];
		const missing: string[] = [];

		for (const field of criticalFields) {
			const value = getFieldValue(item, field);
			if (value === undefined || value === null || value === "") {
				missing.push(field);
				allMissing.add(field);
			} else {
				totalPresent++;
			}
		}

		if (missing.length > 0 && item) {
			warnings.push(
				`Item "${item.title?.slice(0, 40)}..." missing: ${missing.join(", ")}`,
			);
		}
	}

	const score = totalExpected > 0 ? totalPresent / totalExpected : 0;

	// Add specific warnings
	if (vertical === "automotive") {
		if (allMissing.has("transmissionType")) {
			warnings.push(
				"TransmissionType missing - check fallback to 'transmission' field",
			);
		}
		if (allMissing.has("make") || allMissing.has("model")) {
			errors.push("CRITICAL: Make/Model missing - vehicle search won't work");
		}
		if (allMissing.has("externalId")) {
			warnings.push("ExternalId missing - deduplication may not work properly");
		}
	}

	return {
		valid: errors.length === 0 && score >= 0.7,
		score,
		warnings,
		errors,
		coverage: {
			expected: totalExpected,
			present: totalPresent,
			missing: Array.from(allMissing),
		},
	};
}

function getCriticalFields(vertical: Vertical): string[] {
	const criticalFieldsByVertical: Record<string, string[]> = {
		automotive: [
			"title",
			"price",
			"make",
			"model",
			"year",
			"mileage",
			"fuel",
			"transmissionType",
			"power",
			"condition",
			"accidentFree",
			"image",
			"url",
		],
		ecommerce: ["title", "price", "image", "url"],
		marketplace: ["title", "price", "location", "seller", "image", "url"],
		real_estate: ["title", "price", "location", "image", "url"],
		content: ["title", "url", "description"],
	};

	return (
		criticalFieldsByVertical[vertical] ||
		criticalFieldsByVertical.ecommerce ||
		[]
	);
}

function getFieldValue(item: unknown, field: string): unknown {
	const parts = field.split(".");
	let value: unknown = item;
	for (const part of parts) {
		if (!value || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}
