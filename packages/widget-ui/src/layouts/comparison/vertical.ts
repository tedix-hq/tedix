import type { PriceCardProps } from "../../components/comparison/price-card";
import type { Vertical } from "@tedix/api-contract/schemas/app";

export type ComparisonVertical =
	| "ecommerce"
	| "real_estate"
	| "automotive"
	| "jobs"
	| "travel"
	| "crypto"
	| "services"
	| "marketplace";

export function getVerticalPriceCardProps(
	vertical: ComparisonVertical,
): Partial<PriceCardProps> {
	const common = { vertical: vertical as Vertical };
	switch (vertical) {
		case "travel":
			return {
				...common,
				ratingStyle: "badge",
				pricePrefix: "From",
				priceUnit: "/ night",
				showTaxNote: true,
				ctaText: "View Deal",
			};
		case "real_estate":
			return { ...common, priceUnit: "/ month", ctaText: "View Listing" };
		case "automotive":
			return { ...common, ctaText: "View Vehicle" };
		case "jobs":
			return {
				...common,
				ratingStyle: "badge",
				priceUnit: "/ year",
				ctaText: "Apply Now",
			};
		case "crypto":
			return { ...common, ctaText: "Trade Now" };
		case "services":
			return {
				...common,
				ratingStyle: "badge",
				pricePrefix: "From",
				priceUnit: "/ session",
				ctaText: "Book Now",
			};
		case "marketplace":
			return { ...common, ctaText: "View Listing" };
		default:
			return { ...common, ctaText: "View Offer" };
	}
}
