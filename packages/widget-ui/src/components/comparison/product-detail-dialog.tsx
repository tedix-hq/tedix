"use client";

/**
 * ProductDetailDialog - Full product detail modal with offers list
 *
 * Modal dialog that shows full product details with all merchant offers
 * when user clicks a product card in the carousel.
 *
 * **Features:**
 * - Product image with title and rating
 * - Brand/seller information
 * - Offers list sorted by price (lowest first)
 * - Per-offer: merchant name/logo, price, shipping, stock status, CTA
 * - Fallback to single CTA when no offers array
 * - Mobile responsive with bottom sheet option
 * - Dark mode support
 *
 * **Use Cases:**
 * - Price comparison layouts (clicking a product shows all merchants)
 * - Multi-merchant shopping widgets
 * - Aggregated search results with offer drilling
 *
 * @example
 * ```tsx
 * <ProductDetailDialog
 *   item={selectedProduct}
 *   open={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   currency="EUR"
 *   onExternalClick={(item, offer) => trackClick(offer)}
 * />
 * ```
 */

import { ExternalLink, Image as ImageIcon, Star } from "lucide-react";
import { type CurrencyCode, formatPrice } from "../../lib/price-utils";
import type {
	LayoutItemSchemaType as LayoutItem,
	LayoutItemOfferSchemaType as LayoutItemOffer,
} from "@tedix/api-contract/schemas/layout";
import { Badge } from "../badge";
import { Button } from "../button";
import { Chip } from "../chip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../dialog";
import { ExpandableText } from "../expandable-text";
import { Image } from "../image";
import { PhotoCarousel } from "../photo-carousel";
import { Separator } from "../separator";
import { OfferRow } from "./offer-row";

// =============================================================================
// Types
// =============================================================================

export interface ProductDetailDialogProps {
	/** The product to display */
	item: LayoutItem | null;
	/** Whether dialog is open */
	open: boolean;
	/** Close handler */
	onClose: () => void;
	/** Currency code (ISO 4217, e.g., "EUR", "USD") */
	currency?: string;
	/** Callback when user clicks to view offer on merchant site */
	onExternalClick?: (item: LayoutItem, offer?: LayoutItemOffer) => void;
}

// =============================================================================
// Main Component
// =============================================================================

export function ProductDetailDialog({
	item,
	open,
	onClose,
	currency = "EUR",
	onExternalClick,
}: ProductDetailDialogProps) {
	if (!item) return null;

	// Sort offers by price (lowest first)
	const sortedOffers = item.offers
		? [...item.offers].sort((a, b) => a.price - b.price)
		: [];

	const lowestPrice = sortedOffers[0]?.price;
	const hasOffers = sortedOffers.length > 0;
	const hasExternalAction = Boolean(onExternalClick);
	const handleOfferExternalClick = (
		offer: LayoutItemOffer,
	): (() => void) | undefined => {
		if (!onExternalClick) return undefined;
		if (offer.url) {
			return () => onExternalClick(item, offer);
		}
		if (item.url) {
			return () => onExternalClick(item, { ...offer, url: item.url });
		}
		return undefined;
	};

	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<DialogContent
				size="lg"
				mobileBottomSheet
				className="max-h-[90vh] overflow-hidden"
				aria-describedby={undefined}
			>
				{/* Screen reader accessible title */}
				<DialogHeader className="sr-only">
					<DialogTitle>{item.title}</DialogTitle>
				</DialogHeader>

				{/* Scrollable content area */}
				<div className="-mx-6 -mb-6 flex max-h-[calc(90vh-4rem)] flex-col overflow-y-auto px-6 pb-6">
					{/* Product header section */}
					<div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
						{/* Product image - constrained height on mobile */}
						<div className="relative aspect-square max-h-48 w-full shrink-0 overflow-hidden rounded-xl bg-muted sm:max-h-none sm:w-32 md:w-40">
							{item.images && item.images.length > 0 ? (
								<PhotoCarousel
									images={item.images}
									aspectRatio="1/1"
									showDots={item.images.length > 1}
									showArrows={item.images.length > 1}
									className="size-full"
								/>
							) : item.image ? (
								<Image
									src={item.image}
									alt=""
									aria-hidden="true"
									className="size-full object-cover"
								/>
							) : (
								<div className="flex size-full items-center justify-center">
									<ImageIcon className="size-12 text-muted-foreground/40" />
								</div>
							)}
						</div>

						{/* Product info */}
						<div className="flex min-w-0 flex-1 flex-col gap-2">
							{/* Visible title (duplicated from DialogTitle for visual display) */}
							<h2 className="font-semibold text-lg leading-tight md:text-xl">
								{item.title}
							</h2>

							{/* Rating */}
							{item.rating && (
								<div className="flex items-center gap-2">
									<Badge
										variant="rating"
										size="sm"
										className="px-1.5 font-bold"
									>
										<span className="mr-1">{item.rating.value.toFixed(1)}</span>
										<Star className="size-3 fill-current" />
									</Badge>
									{item.rating.count != null && (
										<span className="text-muted-foreground text-sm">
											({item.rating.count.toLocaleString()} reviews)
										</span>
									)}
								</div>
							)}

							{/* Brand/Seller with optional logo */}
							{item.seller && (
								<div className="flex items-center gap-2">
									{item.seller.avatar && (
										<img
											src={item.seller.avatar}
											alt=""
											className="size-5 rounded object-contain"
										/>
									)}
									<p className="text-muted-foreground text-sm">
										Brand:{" "}
										<span className="font-medium text-foreground">
											{item.seller.name}
										</span>
									</p>
								</div>
							)}

							{/* Product description */}
							{item.description && (
								<ExpandableText
									maxLines={3}
									className="text-muted-foreground text-sm"
								>
									{item.description}
								</ExpandableText>
							)}

							{/* Product features/specs */}
							{item.features && item.features.length > 0 && (
								<div className="flex flex-wrap gap-2">
									{item.features.slice(0, 6).map((feature) => (
										<Chip key={feature.label} variant="secondary" size="sm">
											<span className="opacity-80">{feature.label}:</span>
											<span className="font-medium">{feature.value}</span>
										</Chip>
									))}
								</div>
							)}

							{/* Offer summary */}
							{hasOffers && (
								<p className="text-muted-foreground text-sm">
									Compare{" "}
									<span className="font-medium text-foreground">
										{sortedOffers.length}{" "}
										{sortedOffers.length === 1 ? "offer" : "offers"}
									</span>{" "}
									from{" "}
									<span className="font-semibold text-success">
										{formatPrice(lowestPrice, currency as CurrencyCode)}
									</span>
								</p>
							)}
						</div>
					</div>

					{/* Divider */}
					<Separator className="my-4" />

					{/* Offers list */}
					{hasOffers ? (
						<div className="flex flex-col gap-3">
							<h3 className="font-medium text-muted-foreground text-sm">
								{sortedOffers.length === 1
									? "Available offer"
									: `${sortedOffers.length} offers (lowest price first)`}
							</h3>
							<div
								className="flex flex-col gap-2"
								role="list"
								aria-label="Product offers"
							>
								{sortedOffers.map((offer, index) => (
									<div
										key={offer.merchantId || `offer-${index}`}
										role="listitem"
									>
										<OfferRow
											offer={offer}
											currency={currency}
											variant="dialog"
											isLowestPrice={offer.price === lowestPrice}
											onExternalClick={handleOfferExternalClick(offer)}
										/>
									</div>
								))}
							</div>
						</div>
					) : (
						/* Fallback: Single CTA to item.url */
						<div className="flex flex-col items-center gap-4 py-6 text-center">
							{item.price?.amount != null ? (
								<p className="text-muted-foreground">
									<span className="block font-bold text-2xl text-foreground">
										{item.price.formatted ||
											formatPrice(item.price.amount, currency as CurrencyCode)}
									</span>
								</p>
							) : (
								<p className="text-muted-foreground">View product details</p>
							)}
							{hasExternalAction && (
								<>
									<Button
										size="lg"
										onClick={() => onExternalClick?.(item)}
										disabled={!item.url}
										className="min-h-12"
										aria-label={`View ${item.title} on merchant site`}
									>
										View Product
										<ExternalLink className="size-4" />
									</Button>
									{!item.url && (
										<p className="text-muted-foreground text-xs">
											No product link available
										</p>
									)}
								</>
							)}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
