import * as z from "zod";

/**
 * Field Mapping Configuration
 * Single source of truth for how Firecrawl fields map to ExtractedItem fields
 *
 * Benefits:
 * - DRY: Define mappings once, use everywhere
 * - Type-safe: Zod schemas provide runtime validation
 * - Maintainable: Add new fields in one place
 */

// Define the complete ExtractedItem schema with Zod
export const ExtractedItemSchema = z.object({
	// Core fields
	sku: z.string().optional(),
	title: z.string(),
	subtitle: z.string().optional(),
	description: z.string().optional(),
	url: z.string().optional(),
	image: z.string().optional(),
	images: z.array(z.string()).optional(),

	// Pricing
	price: z.number().optional(),
	originalPrice: z.number().optional(),
	priceNegotiable: z.boolean().optional(),
	currency: z.string().optional(),

	// Rating/Reviews
	rating: z.number().optional(),
	reviewCount: z.number().optional(),
	badge: z.string().optional(),
	category: z.string().optional(),
	availability: z.string().optional(),

	// Location
	location: z
		.object({
			address: z.string().optional(),
			city: z.string().optional(),
			region: z.string().optional(),
			zipCode: z.string().optional(),
			country: z.string().optional(),
			lat: z.number().optional(),
			lng: z.number().optional(),
		})
		.optional(),

	// Seller
	seller: z
		.object({
			name: z.string().optional(),
			verified: z.boolean().optional(),
			avatar: z.string().optional(),
			rating: z.number().optional(),
			phone: z.string().optional(),
		})
		.optional(),

	// Features (supports both string[] from AI extraction and object[] from DB)
	features: z
		.array(
			z.union([
				z.string(), // AI agents may extract as simple strings
				z.object({
					// Normalized format for DB storage
					label: z.string(),
					value: z.string(),
				}),
			]),
		)
		.optional(),

	// Automotive-specific fields
	make: z.string().optional(),
	model: z.string().optional(),
	variant: z.string().optional(),
	trim: z.string().optional(),
	year: z.string().optional(),
	mileage: z.string().optional(),
	mileageUnit: z.string().optional(),
	fuel: z.string().optional(),
	transmissionType: z.string().optional(),
	transmissionDetails: z.string().optional(),
	power: z.string().optional(),
	powerKw: z.number().optional(),
	powerPs: z.number().optional(),
	engineSize: z.string().optional(),
	bodyType: z.string().optional(),
	color: z.string().optional(),
	interiorColor: z.string().optional(),
	doors: z.number().optional(),
	condition: z.string().optional(),
	accidentFree: z.boolean().optional(),
	previousOwners: z.number().optional(),
	inspectionDate: z.string().optional(),

	metadata: z
		.record(
			z.string(),
			z.union([z.string(), z.number(), z.boolean(), z.null()]),
		)
		.optional(),
});

export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

/**
 * Vertical-specific default field mappings
 * Supports multiple languages and common field name variations
 * Apps can override these in D1: metadata.extractionConfig.fieldMappings
 */
const COMMON_FIELD_MAPPINGS: Record<string, string[]> = {
	sku: ["sku", "externalId"],
	title: ["title"],
	subtitle: ["subtitle"],
	description: ["description"],
	url: ["url"],
	image: ["image", "imageUrl"],
	images: ["images"],
	price: ["price"],
	originalPrice: ["originalPrice"],
	priceNegotiable: ["priceNegotiable"],
	currency: ["currency"],
	rating: ["rating"],
	reviewCount: ["reviewCount"],
	badge: ["badge"],
	category: ["category"],
	availability: ["availability"],
	"location.address": ["address"],
	"location.city": ["city"],
	"location.zipCode": ["zipCode", "postalCode"],
	"location.region": ["region"],
	"location.lat": ["lat"],
	"location.lng": ["lng"],
	"seller.name": ["dealer", "dealerName", "seller"],
	"seller.verified": ["sellerVerified"],
	make: ["make"],
	model: ["model"],
	variant: ["variant"],
	trim: ["trim"],
	year: ["year"],
	mileage: ["mileage"],
	mileageUnit: ["mileageUnit"],
	fuel: ["fuel"],
	transmissionType: ["transmissionType", "transmission"],
	transmissionDetails: ["transmissionDetails"],
	power: ["power"],
	powerKw: ["powerKw"],
	powerPs: ["powerPs"],
	engineSize: ["engineSize"],
	bodyType: ["bodyType"],
	color: ["color"],
	interiorColor: ["interiorColor"],
	doors: ["doors"],
	condition: ["condition"],
	accidentFree: ["accidentFree"],
	previousOwners: ["previousOwners"],
	inspectionDate: ["inspectionDate"],
};

export const VERTICAL_FIELD_MAPPINGS: Record<
	string,
	Record<string, string[]>
> = {
	automotive: {
		...COMMON_FIELD_MAPPINGS,
		// Identity
		sku: ["sku", "externalId", "id", "fahrzeugNr", "angebotId"],
		make: ["make", "manufacturer", "brand", "hersteller", "marke"],
		model: ["model", "modell"],
		variant: ["variant", "variante"],
		trim: ["trim", "ausstattung", "linie"],

		// Pricing (includes snake_case Firecrawl output format)
		price: ["price", "preis", "price_amount"],
		originalPrice: [
			"originalPrice",
			"uvp",
			"listPrice",
			"msrp",
			"original_price",
		],
		currency: ["currency", "price_currency"],

		// Specs (includes snake_case Firecrawl output format)
		year: ["year", "baujahr", "erstzulassung"],
		mileage: ["mileage", "kilometerstand", "laufleistung"],
		mileageUnit: ["mileageUnit", "mileage_unit"],
		fuel: ["fuel", "kraftstoff", "fuelType", "fuel_type"],
		transmissionType: [
			"transmissionType",
			"transmission",
			"getriebe",
			"gearbox",
		],
		power: ["power", "leistung"],
		engineSize: ["engineSize", "hubraum", "displacement"],
		bodyType: ["bodyType", "karosserie", "fahrzeugtyp"],
		color: ["color", "farbe", "aussenfarbe", "exterior_color"],
		interiorColor: ["interiorColor", "interior_color", "innenfarbe"],

		// Condition
		condition: ["condition", "fahrzeugzustand", "zustand"],
		accidentFree: ["accidentFree", "unfallfrei", "accidentHistory"],

		// Location (includes snake_case Firecrawl output format)
		"location.city": ["city", "location", "ort", "stadt"],
		"location.zipCode": [
			"zipCode",
			"postalCode",
			"plz",
			"postleitzahl",
			"postal_code",
		],
		"location.region": ["region", "bundesland", "state"],
		"location.country": ["country"],

		// Seller
		"seller.name": ["dealer", "seller", "händler", "verkäufer", "autohaus"],
		sellerType: ["sellerType", "verkäufertyp"],
	},

	jobs: {
		...COMMON_FIELD_MAPPINGS,
		sku: ["sku", "jobId", "id", "stellenId"],
		title: ["title", "jobTitle", "position", "stellentitel"],
		"seller.name": ["company", "employer", "firma", "arbeitgeber"],
		"location.city": ["city", "location", "ort", "stadt"],
		salary: ["salary", "gehalt", "compensation"],
		employmentType: ["employmentType", "jobType", "beschäftigungsart"],
	},

	ecommerce: {
		...COMMON_FIELD_MAPPINGS,
		sku: ["sku", "id", "productId", "artikelNr"],
		title: ["title", "name", "produktName"],
		price: ["price", "preis"],
		category: ["category", "kategorie"],
		brand: ["brand", "marke", "hersteller"],
	},

	marketplace: {
		...COMMON_FIELD_MAPPINGS,
		sku: ["sku", "id", "anzeigenId"],
		title: ["title", "titel"],
		price: ["price", "preis"],
		"location.city": ["city", "location", "ort"],
		"seller.name": ["seller", "verkäufer", "anbieter"],
		condition: ["condition", "zustand"],
	},

	real_estate: {
		...COMMON_FIELD_MAPPINGS,
		sku: ["sku", "id", "objektId", "immobilienId"],
		title: ["title", "titel"],
		price: ["price", "preis", "kaltmiete", "kaufpreis"],
		"location.city": ["city", "ort", "stadt"],
		rooms: ["rooms", "zimmer"],
		area: ["area", "wohnfläche", "sqm"],
	},
};

export type MutableNestedRecord = Record<string, unknown>;

/**
 * Auto-map fields from raw Firecrawl item to ExtractedItem
 * Uses vertical-specific field mappings with multi-language support
 *
 * @param rawItem - Raw item from Firecrawl response
 * @param fieldMappings - Optional field mappings (defaults to automotive vertical)
 * @returns Partial<ExtractedItem> with all mapped fields
 */
export function autoMapFields(
	rawItem: Record<string, unknown>,
	fieldMappings?: Record<string, string[]>,
): Partial<ExtractedItem> {
	const result: MutableNestedRecord = {};

	// Use provided mappings or default to automotive vertical
	const mappings = fieldMappings || VERTICAL_FIELD_MAPPINGS.automotive || {};

	// Map all simple fields using the vertical-specific mappings
	for (const [targetField, sourceFields] of Object.entries(mappings)) {
		// Try each source field in order until we find a value
		for (const sourceField of sourceFields) {
			const sourceValue = rawItem[sourceField];

			if (sourceValue === undefined || sourceValue === null) continue;

			// Found a value - set it and break the fallback chain
			setNestedField(result, targetField, sourceValue);
			break; // Stop trying fallbacks once we have a value
		}
	}

	// Handle location field (complex nested object with multiple sources)
	const location = mapLocationField(rawItem);
	if (location) result.location = location;

	// Handle seller field (complex nested object with dealer fallback)
	const seller = mapSellerField(rawItem);
	if (seller) result.seller = seller;

	// Handle features array (keep if present)
	if (Array.isArray(rawItem.features)) {
		result.features = rawItem.features;
	}

	// Add default currency if price exists but no currency
	if (result.price && !result.currency) {
		result.currency = "EUR";
	}

	return result;
}

/**
 * Special handling for nested location fields
 * Location can come from multiple sources (object, top-level fields, postalCode)
 */
function mapLocationField(
	rawItem: Record<string, unknown>,
): ExtractedItem["location"] | undefined {
	let location: ExtractedItem["location"] | undefined;

	// 1. Check if location exists as an object
	if (typeof rawItem.location === "string") {
		location = { address: rawItem.location };
	} else if (rawItem.location && typeof rawItem.location === "object") {
		location = rawItem.location as ExtractedItem["location"];
	}

	// 2. Map top-level location fields into location object
	if (rawItem.zipCode || rawItem.lat || rawItem.lng || rawItem.region) {
		location = location || {};
		if (typeof rawItem.zipCode === "string") location.zipCode = rawItem.zipCode;
		if (typeof rawItem.lat === "number") location.lat = rawItem.lat;
		if (typeof rawItem.lng === "number") location.lng = rawItem.lng;
		if (typeof rawItem.region === "string") location.region = rawItem.region;
	}

	// 3. Current automotive extraction emits postalCode from dealer addresses.
	if (typeof rawItem.postalCode === "string") {
		location = {
			...location,
			zipCode: rawItem.postalCode,
		};
	}

	// 4. Handle city field
	if (typeof rawItem.city === "string") {
		location = {
			...location,
			city: rawItem.city,
		};
	}

	// 5. Handle coordinates object (from travel vertical)
	if (rawItem.coordinates && typeof rawItem.coordinates === "object") {
		const coords = rawItem.coordinates as { lat?: number; lng?: number };
		if (typeof coords.lat === "number" && typeof coords.lng === "number") {
			location = {
				...location,
				lat: coords.lat,
				lng: coords.lng,
			};
		}
	}

	return location;
}

/**
 * Special handling for nested seller fields
 * Seller can come from multiple sources (object, dealer field)
 */
function mapSellerField(
	rawItem: Record<string, unknown>,
): ExtractedItem["seller"] | undefined {
	let seller: ExtractedItem["seller"] | undefined;

	// 1. Check if dealer field exists (automotive vertical)
	if (typeof rawItem.dealer === "string") {
		seller = { name: rawItem.dealer, verified: true }; // Assume dealers are verified
	}

	// 2. Check if seller field exists
	if (typeof rawItem.seller === "string") {
		seller = { name: rawItem.seller };
	} else if (rawItem.seller && typeof rawItem.seller === "object") {
		seller = rawItem.seller as ExtractedItem["seller"];
	}

	return seller;
}

/**
 * Set nested field value (handles paths like "location.city")
 */
function setNestedField(
	obj: MutableNestedRecord,
	path: string,
	value: unknown,
) {
	const parts = path.split(".");

	if (parts.length === 1) {
		const key = parts[0];
		if (key) obj[key] = value;
		return;
	}

	let current: MutableNestedRecord = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (!part) continue;
		const next = current[part];
		if (!next || typeof next !== "object") {
			current[part] = {};
		}
		current = current[part] as MutableNestedRecord;
	}
	const lastPart = parts[parts.length - 1];
	if (lastPart) {
		current[lastPart] = value;
	}
}
