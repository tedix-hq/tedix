import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";

export type ComparisonSort = "relevance" | "price" | "rating" | "delivery";

export interface ComparisonFilters {
	freeShipping?: boolean;
	inStock?: boolean;
	topRated?: boolean;
}

const UNKNOWN_DELIVERY_DAYS = Number.POSITIVE_INFINITY;

export function hasFreeShipping(item: LayoutItem): boolean {
	return (
		item.shipping?.free === true ||
		item.shipping?.cost === 0 ||
		item.offers?.some((offer) => offer.shippingCost === 0) === true
	);
}

export function isInStock(item: LayoutItem): boolean {
	return (
		item.stock?.status === "in_stock" ||
		item.offers?.some((offer) => offer.stockStatus === "in_stock") === true
	);
}

export function getDeliveryDays(item: LayoutItem): number {
	return (
		item.shipping?.maxDays ??
		Math.min(
			...(item.offers
				?.map((offer) => offer.deliveryDays)
				.filter((days): days is number => days != null) ?? []),
			UNKNOWN_DELIVERY_DAYS,
		)
	);
}

export function filterAndSortItems<T extends LayoutItem>(
	items: readonly T[],
	filters: ComparisonFilters,
	sortBy: ComparisonSort,
): T[] {
	const filtered = items.filter(
		(item) =>
			(!filters.freeShipping || hasFreeShipping(item)) &&
			(!filters.inStock || isInStock(item)) &&
			(!filters.topRated || (item.rating?.value ?? 0) >= 4),
	);

	switch (sortBy) {
		case "price":
			return [...filtered].sort(
				(a, b) =>
					(a.price?.amount ?? Number.POSITIVE_INFINITY) -
					(b.price?.amount ?? Number.POSITIVE_INFINITY),
			);
		case "rating":
			return [...filtered].sort(
				(a, b) => (b.rating?.value ?? 0) - (a.rating?.value ?? 0),
			);
		case "delivery":
			return [...filtered].sort(
				(a, b) => getDeliveryDays(a) - getDeliveryDays(b),
			);
		default:
			return filtered;
	}
}

export function getBestPrice(items: readonly LayoutItem[]): number | null {
	const prices = items.flatMap((item) =>
		item.price?.amount == null ? [] : [item.price.amount],
	);
	return prices.length === 0 ? null : Math.min(...prices);
}
