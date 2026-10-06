/**
 * Items Schema
 * Universal LayoutItem storage for all verticals
 * Matches the platform D1 schema managed through versioned migrations.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	real,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";

export const items = sqliteTable(
	"items",
	{
		id: text("id").primaryKey(),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		externalId: text("external_id"),
		vertical: text("vertical").notNull(),

		// Core fields (aligned with LayoutItem)
		title: text("title").notNull(),
		subtitle: text("subtitle"),
		description: text("description"),

		// Media (aligned with LayoutItem)
		image: text("image"),
		images: text("images", { mode: "json" }).$type<string[]>(), // JSON array of image URLs

		// Pricing (aligned with LayoutItem.price object)
		priceAmount: real("price_amount"),
		priceCurrency: text("price_currency").default("EUR"),
		priceOriginal: real("price_original"),
		priceFormatted: text("price_formatted"),

		// Rating (aligned with LayoutItem.rating object)
		ratingValue: real("rating_value"),
		ratingCount: text("rating_count"), // Using text to store integers > 2^53
		ratingMax: real("rating_max"),

		// Badge (aligned with LayoutItem.badge object)
		badgeText: text("badge_text"),
		badgeVariant: text("badge_variant"), // BadgeVariant: default, secondary, destructive, success, warning, outline

		// Location (aligned with LayoutItem.location object)
		locationLat: real("location_lat"),
		locationLng: real("location_lng"),
		locationAddress: text("location_address"),
		locationCity: text("location_city"),
		locationCountry: text("location_country"),

		// Seller (aligned with LayoutItem.seller object)
		sellerId: text("seller_id"),
		sellerName: text("seller_name"),
		sellerAvatar: text("seller_avatar"),
		sellerVerified: text("seller_verified"), // Using text for boolean: "true"/"false"
		sellerRating: real("seller_rating"),

		// Features (aligned with LayoutItem.features array)
		features: text("features", { mode: "json" }).$type<
			Array<{ label: string; value: string; icon?: string }>
		>(), // JSON array of {label, value, icon?}

		// Actions (aligned with LayoutItem.actions array)
		actions: text("actions", { mode: "json" }).$type<
			Array<{ label: string; action: string; primary?: boolean; icon?: string }>
		>(), // JSON array of {label, action, primary?, icon?}

		// Source URL - unique constraint prevents duplicate scrapes
		url: text("url"),

		// Vertical-specific JSON metadata (escape hatch)
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_items_app").on(table.appId),
		index("idx_items_vertical").on(table.vertical),
		unique("uq_items_app_url").on(table.appId, table.url),
	],
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;

/**
 * Item metadata is stored as JSON in the metadata column.
 * The structure varies by vertical:
 *
 * - ecommerce: { sku, brand, category, inStock }
 * - automotive: { make, model, year, mileage, transmission, fuelType, bodyType, color, power }
 * - marketplace: { category, condition }
 * - real_estate: { propertyType, size, rooms, bedrooms, bathrooms, floor, yearBuilt, amenities }
 * - jobs: { company, employmentType, salaryRange, experienceLevel, postedDate }
 * - services: { provider, specialty, availability }
 * - crypto: { symbol, change24h, change7d, marketCap, volume, circulatingSupply }
 * - travel: { propertyType, starRating, amenities, roomType, checkInOut }
 */

import type { BadgeVariant } from "@tedix/api-contract/schemas/common";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";

/**
 * Convert Item from database to LayoutItem for widget display
 */
export function itemToLayoutItem(item: Item): LayoutItem {
	// Drizzle mode: "json" auto-deserializes — no parseJsonField needed
	const metadata = item.metadata ?? undefined;

	// Build features array from stored features OR automotive metadata
	let features: LayoutItem["features"];
	if (item.features) {
		features = (item.features as LayoutItem["features"]) ?? undefined;
	} else if (item.vertical === "automotive" && metadata) {
		// Extract automotive specs from metadata for ComparisonLayout
		features = [];
		if (metadata.year)
			features.push({ label: "Year", value: String(metadata.year) });
		if (metadata.mileage && metadata.mileageUnit) {
			const mileage = Number(metadata.mileage).toLocaleString("de-DE");
			features.push({
				label: "Mileage",
				value: `${mileage} ${metadata.mileageUnit}`,
			});
		}
		if (metadata.fuel)
			features.push({ label: "Fuel", value: String(metadata.fuel) });
		if (metadata.transmissionDetails)
			features.push({
				label: "Transmission",
				value: String(metadata.transmissionDetails),
			});
		if (metadata.power)
			features.push({ label: "Power", value: String(metadata.power) });
		if (metadata.engineSize)
			features.push({ label: "Engine", value: String(metadata.engineSize) });
		if (metadata.bodyType)
			features.push({ label: "Body Type", value: String(metadata.bodyType) });
		if (metadata.color)
			features.push({ label: "Color", value: String(metadata.color) });
		if (metadata.condition)
			features.push({ label: "Condition", value: String(metadata.condition) });
	}

	// Extract location from metadata if not in dedicated columns
	const metadataLocation = metadata?.location as string | undefined;

	return {
		id: item.id,
		title: item.title,
		subtitle: item.subtitle ?? undefined,
		description: item.description ?? undefined,
		image: item.image ?? undefined,
		images: item.images ?? undefined,
		price: item.priceAmount
			? {
					amount: item.priceAmount,
					currency: item.priceCurrency ?? "EUR",
					original: item.priceOriginal ?? undefined,
					formatted: item.priceFormatted ?? undefined,
				}
			: undefined,
		rating: item.ratingValue
			? {
					value: item.ratingValue,
					count: item.ratingCount
						? Number.parseInt(item.ratingCount, 10)
						: undefined,
					max: item.ratingMax ?? undefined,
				}
			: undefined,
		badge:
			item.badgeText && item.badgeVariant
				? {
						text: item.badgeText,
						variant: item.badgeVariant as BadgeVariant,
					}
				: undefined,
		location:
			item.locationLat || item.locationLng || item.locationAddress
				? {
						lat: item.locationLat ?? undefined,
						lng: item.locationLng ?? undefined,
						address: item.locationAddress ?? undefined,
						city: item.locationCity ?? undefined,
						country: item.locationCountry ?? undefined,
					}
				: metadataLocation
					? { city: metadataLocation }
					: undefined,
		seller: item.sellerName
			? {
					id: item.sellerId ?? undefined,
					name: item.sellerName,
					avatar: item.sellerAvatar ?? undefined,
					verified: item.sellerVerified === "true",
					rating: item.sellerRating ?? undefined,
				}
			: metadata?.dealer
				? {
						name: String(metadata.dealer),
					}
				: undefined,
		features,
		actions: (item.actions as LayoutItem["actions"]) ?? undefined,
		url: item.url ?? undefined,
		metadata,
	};
}

/**
 * Convert LayoutItem to Item for database storage
 */
export function layoutItemToItem(
	layoutItem: LayoutItem,
	appId: string,
	vertical: string,
): NewItem {
	return {
		id: layoutItem.id,
		appId,
		vertical,
		title: layoutItem.title,
		subtitle: layoutItem.subtitle ?? null,
		description: layoutItem.description ?? null,
		image: layoutItem.image ?? null,
		images: layoutItem.images ?? null,
		priceAmount: layoutItem.price?.amount ?? null,
		priceCurrency: layoutItem.price?.currency ?? "EUR",
		priceOriginal: layoutItem.price?.original ?? null,
		priceFormatted: layoutItem.price?.formatted ?? null,
		ratingValue: layoutItem.rating?.value ?? null,
		ratingCount: layoutItem.rating?.count?.toString() ?? null,
		ratingMax: layoutItem.rating?.max ?? null,
		badgeText: layoutItem.badge?.text ?? null,
		badgeVariant: layoutItem.badge?.variant ?? null,
		locationLat: layoutItem.location?.lat ?? null,
		locationLng: layoutItem.location?.lng ?? null,
		locationAddress: layoutItem.location?.address ?? null,
		locationCity: layoutItem.location?.city ?? null,
		locationCountry: layoutItem.location?.country ?? null,
		sellerId: layoutItem.seller?.id ?? null,
		sellerName: layoutItem.seller?.name ?? null,
		sellerAvatar: layoutItem.seller?.avatar ?? null,
		sellerVerified: layoutItem.seller?.verified ? "true" : "false",
		sellerRating: layoutItem.seller?.rating ?? null,
		features: layoutItem.features ?? null,
		actions: layoutItem.actions ?? null,
		url: layoutItem.url ?? null,
		metadata: layoutItem.metadata ?? null,
	};
}
