/** Normalize imported and extracted items into the shared storage shape. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { Vertical } from "@tedix/api-contract/schemas/app";
import { omitUndefined } from "../lib/json";
import { autoMapFields, ExtractedItemSchema } from "./field-mapping-config";

export interface ExtractedItem {
	sku?: string;
	title: string;
	subtitle?: string;
	description?: string;
	url?: string;
	image?: string;
	images?: string[];
	price?: number;
	originalPrice?: number;
	priceNegotiable?: boolean;
	currency?: string;
	rating?: number;
	reviewCount?: number;
	badge?: string;
	category?: string;
	availability?: string;
	features?: Array<{ label: string; value: string }>;
	location?: {
		address?: string;
		city?: string;
		region?: string;
		zipCode?: string;
		country?: string;
		lat?: number;
		lng?: number;
	};
	seller?: {
		name?: string;
		verified?: boolean;
		avatar?: string;
		rating?: number;
		phone?: string;
	};
	// Cloudflare Workflows require serializable types (no unknown, functions, symbols)
	// Metadata must use JSON-serializable primitives or nested objects/arrays
	metadata?: Record<string, JsonValue>;

	// Automotive-specific properties (optional, only used for automotive vertical)
	make?: string;
	model?: string;
	variant?: string;
	trim?: string;
	year?: string;
	mileage?: string;
	mileageUnit?: string;
	fuel?: string;
	transmissionType?: string;
	transmissionDetails?: string;
	power?: string;
	powerKw?: number;
	powerPs?: number;
	engineSize?: string;
	bodyType?: string;
	color?: string;
	interiorColor?: string;
	doors?: number;
	condition?: string;
	accidentFree?: boolean;
	previousOwners?: number;
	inspectionDate?: string;
}

export function normalizeItems(
	rawItems: unknown[],
	fieldMappings?: Record<string, string[]>,
): ExtractedItem[] {
	return rawItems
		.filter((item): item is Record<string, unknown> => {
			// Accept items with title OR make+model (for automotive)
			return (
				item !== null &&
				typeof item === "object" &&
				("title" in item || ("make" in item && "model" in item))
			);
		})
		.map((rawItem) => {
			// Auto-map all configured fields through the vertical mapping engine.
			const mapped = autoMapFields(rawItem, fieldMappings);

			// Normalize image: if image is missing but images[] exists, use images[0]
			if (
				!mapped.image &&
				Array.isArray(mapped.images) &&
				mapped.images.length > 0
			) {
				mapped.image = mapped.images[0];
			}

			// Normalize sku: derive from URL if missing (ensures deterministic IDs in workflow)
			if (!mapped.sku && mapped.url) {
				const numericId = extractNumericIdFromUrl(mapped.url);
				if (numericId) {
					mapped.sku = numericId;
				} else {
					// Use hash fallback for URLs without numeric IDs
					mapped.sku = `url-${hashString(mapped.url)}`;
				}
			}

			// For automotive items without title, generate from make+model+variant
			if (!mapped.title && mapped.make && mapped.model) {
				mapped.title =
					`${mapped.make} ${mapped.model}${mapped.variant ? ` ${mapped.variant}` : ""}`.trim();
			}

			// Validate against schema (optional, logs warnings in development)
			if (process.env.NODE_ENV !== "production") {
				const validation = ExtractedItemSchema.safeParse(mapped);
				if (!validation.success) {
					console.warn(
						`[Normalizer] Item validation warnings for "${mapped.title || rawItem.title}":`,
						validation.error.issues,
					);
				}
			}

			// Build features array (still manual as it's data transformation, not mapping)
			const features: Array<{ label: string; value: string }> = [];
			if (rawItem.year)
				features.push({ label: "Year", value: String(rawItem.year) });
			if (rawItem.mileage)
				features.push({ label: "Mileage", value: String(rawItem.mileage) });
			if (rawItem.fuel)
				features.push({ label: "Fuel", value: String(rawItem.fuel) });
			if (rawItem.power)
				features.push({ label: "Power", value: String(rawItem.power) });
			if (rawItem.transmission || rawItem.transmissionType) {
				features.push({
					label: "Transmission",
					value: String(rawItem.transmission || rawItem.transmissionType),
				});
			}
			if (rawItem.color)
				features.push({ label: "Color", value: String(rawItem.color) });
			if (rawItem.bodyType)
				features.push({ label: "Body Type", value: String(rawItem.bodyType) });

			// Add existing features if present (handle both string and object formats)
			if (Array.isArray(rawItem.features)) {
				for (const feature of rawItem.features) {
					if (typeof feature === "string") {
						// String features (from Firecrawl agent extraction)
						features.push({ label: "Equipment", value: feature.trim() });
					} else if (
						feature &&
						typeof feature === "object" &&
						"label" in feature
					) {
						// Object features (already formatted)
						features.push(feature as { label: string; value: string });
					}
				}
			}

			return {
				...mapped,
				features: features.length > 0 ? features : undefined,
			} as ExtractedItem;
		});
}

function extractNumericIdFromUrl(url: string): string | null {
	try {
		const parsed = new URL(url);

		// 1. Check common query parameters for ID
		const idParams = ["id", "vehicleId", "listingId", "itemId", "productId"];
		for (const param of idParams) {
			const value = parsed.searchParams.get(param);
			if (value && /^\d+$/.test(value)) {
				return value;
			}
		}

		// 2. Check path for numeric ID patterns
		const path = parsed.pathname;

		// Pattern: /detail/12345678 or /details/12345678
		const detailMatch = path.match(/\/details?\/(\d{6,})/i);
		if (detailMatch?.[1]) {
			return detailMatch[1];
		}

		// Pattern: /angebote/brand-model-12345678 (AutoScout24 style - trailing ID)
		const angeboteMatch = path.match(/\/angebote\/[^/]+-(\d{6,})(?:[/?#]|$)/i);
		if (angeboteMatch?.[1]) {
			return angeboteMatch[1];
		}

		// Pattern: /listing/12345678 or /item/12345678
		const listingMatch = path.match(
			/\/(?:listing|item|product|ad|anzeige)\/(\d{6,})/i,
		);
		if (listingMatch?.[1]) {
			return listingMatch[1];
		}

		// Pattern: Generic path ending with 6+ digit number
		// e.g., /some/path/12345678 or /12345678
		const genericMatch = path.match(/\/(\d{6,})(?:[/?#]|$)/);
		if (genericMatch?.[1]) {
			return genericMatch[1];
		}

		return null;
	} catch {
		return null;
	}
}

function hashString(str: string): string {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = (hash * 33) ^ str.charCodeAt(i);
	}
	// Convert to unsigned 32-bit integer and then to hex
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** A source pointer, not proof that any extracted field occurs on the page. */
function httpSourceUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	try {
		const parsed = new URL(trimmed);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password
		)
			return undefined;
		return trimmed;
	} catch {
		return undefined;
	}
}

export function toItemInsert(
	item: ExtractedItem,
	appId: string,
	vertical: Vertical,
	sourceUrl: string,
) {
	// Agent extraction passes a site label as sourceUrl. Prefer the item's
	// actual listing URL; import workflows can fall back to their source URL.
	const provenanceUrl = httpSourceUrl(item.url) ?? httpSourceUrl(sourceUrl);
	// Extract automotive fields from top-level item and features for filtering
	const automotiveFields: Record<string, string> = {};
	if (vertical === "automotive") {
		if (item.make) automotiveFields.make = item.make;
		if (item.model) automotiveFields.model = item.model;
		if (item.variant) automotiveFields.variant = item.variant;
		if (item.trim) automotiveFields.trim = item.trim;
		if (item.year) automotiveFields.year = String(item.year);
		if (item.mileage) automotiveFields.mileage = String(item.mileage);
		if (item.mileageUnit) automotiveFields.mileageUnit = item.mileageUnit;
		if (item.fuel) {
			automotiveFields.fuel = item.fuel;
			automotiveFields.fuelType = normalizeFuelType(item.fuel);
		}
		if (item.transmissionType)
			automotiveFields.transmission = item.transmissionType;
		if (item.transmissionDetails)
			automotiveFields.transmissionDetails = item.transmissionDetails;
		if (item.power) automotiveFields.power = item.power;
		if (item.powerKw != null) automotiveFields.powerKw = String(item.powerKw);
		if (item.powerPs != null) automotiveFields.powerPs = String(item.powerPs);
		if (item.engineSize) automotiveFields.engineSize = item.engineSize;
		if (item.bodyType) automotiveFields.bodyType = item.bodyType;
		if (item.color) automotiveFields.color = item.color;
		if (item.interiorColor) automotiveFields.interiorColor = item.interiorColor;
		if (item.doors != null) automotiveFields.doors = String(item.doors);
		if (item.condition) automotiveFields.condition = item.condition;
		if (item.accidentFree != null)
			automotiveFields.accidentFree = String(item.accidentFree);
		if (item.previousOwners != null)
			automotiveFields.previousOwners = String(item.previousOwners);
		if (item.inspectionDate)
			automotiveFields.inspectionDate = item.inspectionDate;
		if (item.location) {
			if (item.location.city) automotiveFields.location = item.location.city;
			if (item.location.region) automotiveFields.region = item.location.region;
			if (item.location.zipCode)
				automotiveFields.zipCode = item.location.zipCode;
		}
		if (item.seller?.name) automotiveFields.dealer = item.seller.name;

		if (item.features) {
			for (const feature of item.features) {
				const label = feature.label.toLowerCase();
				const value = feature.value;

				// Map feature labels to filterable metadata keys
				if (label === "fuel" || label === "kraftstoff") {
					// Normalize fuel types for filtering
					const normalized = normalizeFuelType(value);
					automotiveFields.fuelType = normalized;
					automotiveFields.fuel = value; // Keep original
				} else if (label === "year" || label === "baujahr") {
					automotiveFields.year = value;
				} else if (label === "mileage" || label === "kilometerstand") {
					automotiveFields.mileage = value;
				} else if (label === "transmission" || label === "getriebe") {
					automotiveFields.transmission = value;
				} else if (label === "body type" || label === "karosserie") {
					automotiveFields.bodyType = value;
				} else if (label === "power" || label === "leistung") {
					automotiveFields.power = value;
				} else if (label === "color" || label === "farbe") {
					automotiveFields.color = value;
				}
			}
		}
	}

	// Normalize image: if image is missing but images[] exists, use images[0]
	const normalizedImage = item.image || (item.images?.[0] ?? undefined);

	// Derive deterministic ID: prefer sku, then extract from URL, fallback to URL hash
	// This ensures consistent IDs across extractions for deduplication
	let deterministicId = item.sku;
	if (!deterministicId && item.url) {
		const numericId = extractNumericIdFromUrl(item.url);
		if (numericId) {
			deterministicId = numericId;
		} else {
			// Use hash fallback for URLs without numeric IDs
			deterministicId = `url-${hashString(item.url)}`;
		}
	}
	// Final fallback to UUID only if no URL available
	const itemId = deterministicId || crypto.randomUUID();

	return {
		id: itemId,
		appId,
		vertical,
		externalId: deterministicId, // Deterministic ID from SKU or URL (undefined if no URL)
		title: item.title,
		subtitle: item.subtitle,
		description: item.description,
		url: item.url,
		image: normalizedImage,
		images: item.images ?? null,
		priceAmount: item.price,
		priceCurrency: item.currency || "EUR",
		priceOriginal: item.originalPrice,
		ratingValue: item.rating,
		ratingCount: item.reviewCount?.toString(),
		badgeText: item.badge,
		badgeVariant: getBadgeVariant(item.badge),
		locationLat: item.location?.lat,
		locationLng: item.location?.lng,
		locationAddress: item.location?.address,
		locationCity: item.location?.city,
		locationCountry: item.location?.country,
		sellerName: item.seller?.name,
		sellerAvatar: item.seller?.avatar,
		sellerVerified: item.seller?.verified ? "true" : "false",
		features: item.features ?? null,
		metadata: omitUndefined({
			...item.metadata,
			...automotiveFields, // Add automotive fields for filtering
			category: item.category,
			availability: item.availability || "available",
			sourceUrl: provenanceUrl,
			scrapedAt: new Date().toISOString(),
		}),
	};
}

function normalizeFuelType(fuel: string): string {
	const lower = fuel.toLowerCase().trim();

	// Electric
	if (
		lower.includes("elektro") ||
		lower.includes("electric") ||
		lower.includes("ev")
	) {
		return "electric";
	}

	// Hybrid variants
	if (lower.includes("plug-in") || lower.includes("plugin")) {
		return "plug-in-hybrid";
	}
	if (lower.includes("hybrid")) {
		return "hybrid";
	}

	// Diesel
	if (lower.includes("diesel")) {
		return "diesel";
	}

	// Petrol/Gasoline
	if (
		lower.includes("benzin") ||
		lower.includes("petrol") ||
		lower.includes("gasoline")
	) {
		return "petrol";
	}

	// Natural gas
	if (
		lower.includes("erdgas") ||
		lower.includes("cng") ||
		lower.includes("natural gas")
	) {
		return "natural-gas";
	}

	// Hydrogen
	if (lower.includes("wasserstoff") || lower.includes("hydrogen")) {
		return "hydrogen";
	}

	// LPG
	if (lower.includes("lpg") || lower.includes("autogas")) {
		return "lpg";
	}

	return fuel.toLowerCase();
}

function getBadgeVariant(badge?: string): string {
	if (!badge) return "default";
	const lower = badge.toLowerCase();
	if (
		lower.includes("sale") ||
		lower.includes("deal") ||
		lower.includes("discount") ||
		lower.includes("rabatt")
	)
		return "destructive";
	if (lower.includes("new") || lower.includes("neu")) return "success";
	if (
		lower.includes("top") ||
		lower.includes("featured") ||
		lower.includes("bestseller")
	)
		return "warning";
	return "default";
}
