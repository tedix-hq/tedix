"use client";

/**
 * PriceCard - Price comparison result card (Layer 2 Composite)
 *
 * A comprehensive product card for price comparison platforms.
 * Displays product info, merchant details, pricing, ratings, and shipping.
 *
 * **Features:**
 * - Product image with fallback
 * - Title, subtitle, and seller information
 * - Rating display with review count (star or numeric badge style)
 * - Amenity/feature icons from LayoutItem.features
 * - Shipping and stock status badges
 * - Price display with prefix ("From") and unit ("/ night")
 * - Price trend indicators (up/down arrows)
 * - "Best Price" highlighting
 * - External link action (customizable CTA text)
 * - Selection state for comparison
 * - Loading skeleton state
 * - Vertical-aware rendering (travel, ecommerce, automotive, etc.)
 *
 * **Use Cases:**
 * - Price aggregation platforms (Google Shopping)
 * - Multi-merchant search results
 * - Comparison shopping widgets
 * - Travel booking platforms (Kayak, Trivago, Booking.com)
 *
 * @example
 * ```tsx
 * <PriceCard
 *   result={product}
 *   vertical="travel"
 *   isBestPrice={true}
 *   currency="EUR"
 *   pricePrefix="From"
 *   priceUnit="/ night"
 *   ctaText="View on Booking.com"
 *   ratingStyle="badge"
 *   onExternalClick={() => handleRedirect(product)}
 * />
 * ```
 */

import {
	Car,
	Check,
	CheckCircle,
	Clock,
	Coffee,
	Dog,
	Image as ImageIcon,
	Package,
	ParkingCircle,
	Star,
	Store,
	TrendingDown,
	TrendingUp,
	Truck,
	Utensils,
	Wifi,
	Wine,
} from "lucide-react";
import type * as React from "react";
import {
	type CurrencyCode,
	formatPrice,
	getCurrencySymbol,
} from "../../lib/price-utils";
import { cn } from "../../lib/utils";
import type { Vertical } from "@tedix/api-contract/schemas/app";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import { Badge } from "../badge";
import { Button } from "../button";
import { Skeleton } from "../skeleton";

// =============================================================================
// Types
// =============================================================================

export interface PriceCardProps<T extends LayoutItem = LayoutItem> {
	/** Product/result data */
	result?: T;

	/** Vertical context for rendering (travel, ecommerce, automotive, etc.) */
	vertical?: Vertical;

	/** Whether this is the best price among all results */
	isBestPrice?: boolean;

	/** Currency code (default: EUR) */
	currency?: string;

	/** Price prefix text (e.g., "From") */
	pricePrefix?: string;

	/** Price unit text (e.g., "/ night", "/ month") */
	priceUnit?: string;

	/** Show "Includes taxes and fees" note */
	showTaxNote?: boolean;

	/** Rating display style */
	ratingStyle?: "star" | "badge";

	/**
	 * Compact mode for inline carousel view (Apps SDK guideline: "3 lines max metadata")
	 * Hides: subtitle, seller, features, shipping, offer count
	 * Shows: image, title (truncated), rating (simplified), price, CTA
	 */
	compact?: boolean;

	/** Custom CTA button text (default: "View Offer") */
	ctaText?: string;

	/** Whether this item is selected for comparison */
	isSelected?: boolean;

	/** Callback when item is selected/deselected for comparison */
	onSelect?: () => void;

	/** Callback when card body is clicked (opens detail view) */
	onItemClick?: () => void;

	/** Callback when external link button is clicked */
	onExternalClick?: () => void;

	/** Loading state - renders skeleton when true */
	loading?: boolean;

	/** Custom className for container */
	className?: string;
}

// =============================================================================
// Rating Helpers
// =============================================================================

/**
 * Get rating descriptor based on score (Booking.com style)
 * @param rating - Rating value (0-10 scale)
 */
function getRatingDescriptor(rating: number): string {
	if (rating >= 9.0) return "Exceptional";
	if (rating >= 8.5) return "Excellent";
	if (rating >= 8.0) return "Very Good";
	if (rating >= 7.0) return "Good";
	if (rating >= 6.0) return "Pleasant";
	return "Review Score";
}

/**
 * Get rating badge color based on score
 */
function getRatingBadgeColor(rating: number): string {
	if (rating >= 9.0) return "bg-info text-info-foreground";
	if (rating >= 8.0) return "bg-info/90 text-info-foreground";
	if (rating >= 7.0) return "bg-info/80 text-info-foreground";
	return "bg-info/70 text-info-foreground";
}

// =============================================================================
// Feature Icon Mapping
// =============================================================================

/**
 * Map feature icon names to Lucide components
 */
const FEATURE_ICONS: Record<
	string,
	React.ComponentType<{ className?: string }>
> = {
	parking: ParkingCircle,
	wifi: Wifi,
	restaurant: Utensils,
	bar: Wine,
	pets: Dog,
	coffee: Coffee,
	car: Car,
	shipping: Truck,
	verified: CheckCircle,
	store: Store,
	package: Package,
	clock: Clock,
};

// =============================================================================
// Savings Badge Component
// =============================================================================

interface SavingsBadgeProps {
	/** Percentage saved (0-100) */
	percentage?: number;
	/** Amount saved */
	amount?: number;
	/** Currency code */
	currency?: string;
	/** Size variant */
	size?: "sm" | "md";
}

function SavingsBadge({
	percentage,
	amount,
	currency = "EUR",
	size = "sm",
}: SavingsBadgeProps) {
	if (!percentage && !amount) return null;

	// Prefer percentage display (more impactful), fallback to amount
	const displayText = percentage
		? `-${Math.round(percentage)}%`
		: amount
			? `-${getCurrencySymbol(currency as CurrencyCode)}${Math.round(amount).toLocaleString()}`
			: null;

	if (!displayText) return null;

	return (
		<span
			className={cn(
				"absolute top-2 left-2 z-10 rounded-md bg-destructive font-bold text-white",
				size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm",
			)}
		>
			{displayText}
		</span>
	);
}

// =============================================================================
// Shipping Info Component
// =============================================================================

interface ShippingInfoProps {
	/** Shipping cost (0 = free) */
	cost?: number;
	/** Whether shipping is free */
	free?: boolean;
	/** Currency code */
	currency?: string;
	/** Min delivery days */
	minDays?: number;
	/** Max delivery days */
	maxDays?: number;
}

function ShippingInfo({
	cost,
	free,
	currency = "EUR",
	minDays,
	maxDays,
}: ShippingInfoProps) {
	const isFreeShipping = free || cost === 0;

	// Format delivery time
	const deliveryText =
		minDays && maxDays
			? minDays === maxDays
				? `${minDays}d delivery`
				: `${minDays}-${maxDays}d delivery`
			: minDays
				? `${minDays}+ days`
				: maxDays
					? `≤${maxDays}d delivery`
					: null;

	return (
		<div className="flex flex-wrap items-center gap-2 text-xs">
			{/* Shipping cost */}
			{isFreeShipping ? (
				<span className="inline-flex items-center gap-1 font-medium text-success">
					<Truck className="h-3 w-3" />
					Free shipping
				</span>
			) : cost != null ? (
				<span className="inline-flex items-center gap-1 text-muted-foreground">
					<Truck className="h-3 w-3" />+
					{formatPrice(cost, currency as CurrencyCode)} shipping
				</span>
			) : null}

			{/* Delivery time */}
			{deliveryText && (
				<span className="inline-flex items-center gap-1 text-muted-foreground">
					<Clock className="h-3 w-3" />
					{deliveryText}
				</span>
			)}
		</div>
	);
}

// =============================================================================
// Offer Count Badge
// =============================================================================

interface OfferCountBadgeProps {
	/** Number of merchant offers */
	count?: number;
}

function OfferCountBadge({ count }: OfferCountBadgeProps) {
	if (!count || count < 2) return null;

	return (
		<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
			<Store className="h-3 w-3" />
			Compare {count} offers
		</span>
	);
}

// =============================================================================
// Component
// =============================================================================

export function PriceCard<T extends LayoutItem = LayoutItem>({
	result,
	isBestPrice,
	currency = "EUR",
	pricePrefix,
	priceUnit,
	showTaxNote = false,
	ratingStyle = "star",
	compact = false,
	isSelected = false,
	onSelect,
	onItemClick,
	loading = false,
	className,
}: PriceCardProps<T>) {
	// Loading skeleton state
	if (loading || !result) {
		return (
			<div
				className={cn(
					"overflow-hidden rounded-2xl border border-border bg-card",
					className,
				)}
			>
				{/* Image skeleton */}
				<Skeleton className="aspect-[4/3]" />
				{/* Content skeleton */}
				<div className="space-y-3 p-4">
					<div className="space-y-2">
						<Skeleton className="h-5 w-3/4" />
						<Skeleton className="h-4 w-1/2" />
					</div>
					<Skeleton className="h-4 w-20" />
					<Skeleton className="h-4 w-32" />
					<div className="flex items-baseline justify-between">
						<Skeleton className="h-8 w-24" />
					</div>
					<div className="flex gap-2 pt-2">
						<Skeleton className="h-10 flex-1 rounded-lg" />
						<Skeleton className="h-10 w-10 rounded-lg" />
					</div>
				</div>
			</div>
		);
	}

	const priceTrend = result.metadata?.priceTrend as "up" | "down" | undefined;
	const isClickable = Boolean(onItemClick);
	const isSelectable = Boolean(onSelect);
	const offersCount = result.offerCount ?? result.offers?.length ?? 0;
	const detailsLabel = offersCount
		? offersCount === 1
			? "Show offer"
			: `Show ${offersCount} offers`
		: compact
			? "Details"
			: "View Details";

	// Handle card click - opens detail. Compare selection stays on the checkbox.
	// stopPropagation prevents FullscreenGallery item selection
	const handleCardClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (onItemClick) {
			onItemClick();
		} else if (onSelect) {
			onSelect();
		}
	};

	// Handle keyboard navigation: Enter opens detail, Space toggles compare.
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			onItemClick?.();
		}
		if (e.key === " ") {
			e.preventDefault();
			onSelect?.();
		}
	};

	// Handle selection toggle
	const handleSelectClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		onSelect?.();
	};

	const handleSelectKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.stopPropagation();
			e.preventDefault();
			onSelect?.();
		}
	};

	return (
		<div
			className={cn(
				"group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all hover:shadow-lg",
				isSelected && "ring-2 ring-primary",
				isClickable && "cursor-pointer hover:border-primary/50",
				className,
			)}
			onClick={handleCardClick}
			onKeyDown={isClickable ? handleKeyDown : undefined}
			role={isClickable ? "button" : undefined}
			tabIndex={isClickable ? 0 : undefined}
		>
			{/* Image with placeholder fallback + Savings Badge + Selection Checkbox */}
			{/* Compact mode: balanced aspect ratio for dense carousel (3-4 cards) */}
			<div
				className={cn(
					"relative overflow-hidden bg-muted",
					compact ? "aspect-[3/2]" : "aspect-[4/3]",
				)}
			>
				{/* Selection Checkbox (top-right) - only shown when onSelect is provided */}
				{isSelectable && (
					<button
						type="button"
						onClick={handleSelectClick}
						onKeyDown={handleSelectKeyDown}
						className={cn(
							"absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border-2 transition-all",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
							isSelected
								? "border-primary bg-primary text-primary-foreground"
								: "border-border/70 bg-background/50 text-transparent hover:border-border hover:bg-background/70",
							// Always visible (removed hover-only visibility for better UX)
						)}
						aria-label={
							isSelected ? "Deselect item" : "Select item for comparison"
						}
						aria-pressed={isSelected}
					>
						<Check className="h-4 w-4" strokeWidth={3} />
					</button>
				)}

				{/* Savings Badge (top-left) */}
				<SavingsBadge
					percentage={result.savings?.percentage}
					amount={result.savings?.amount}
					currency={currency}
				/>

				{result.image ? (
					<img
						src={result.image}
						alt={result.title}
						className="h-full w-full object-cover"
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center">
						<ImageIcon className="h-12 w-12 text-muted-foreground/40" />
					</div>
				)}
			</div>

			{/* Content - flex-1 to fill remaining space */}
			{/* Compact mode: tighter padding while keeping comfortable spacing */}
			<div className={cn("flex flex-1 flex-col", compact ? "p-3.5" : "p-4")}>
				{/* Top section: Title, Rating, Features */}
				<div className={compact ? "space-y-2" : "space-y-3"}>
					{/* Title and Subtitle */}
					<div>
						<h3
							className={cn(
								"font-semibold",
								compact
									? "line-clamp-2 text-sm leading-snug"
									: "mb-1 text-base",
							)}
						>
							{result.title}
						</h3>
						{/* Hide subtitle and seller in compact mode */}
						{!compact && result.subtitle && (
							<p className="text-muted-foreground text-sm">{result.subtitle}</p>
						)}
						{!compact && result.seller && (
							<div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
								{result.seller.avatar && (
									<img
										src={result.seller.avatar}
										alt=""
										className="size-4 rounded object-contain"
									/>
								)}
								<span>{result.seller.name}</span>
								{result.seller.verified && (
									<CheckCircle className="inline h-3 w-3 text-primary" />
								)}
							</div>
						)}
					</div>

					{/* Rating - simplified in compact mode (badge only) */}
					{result.rating && (
						<div className="flex items-center gap-2">
							{ratingStyle === "badge" ? (
								<>
									{/* Numeric badge style (Booking.com) */}
									<Badge
										variant="default"
										className={cn(
											"rounded-t-md rounded-br-md font-bold hover:bg-opacity-100",
											compact
												? "px-1 py-0 text-[11px]"
												: "px-1.5 py-0.5 text-sm",
											getRatingBadgeColor(result.rating.value),
										)}
									>
										{result.rating.value.toFixed(1)}
									</Badge>
									{/* Hide descriptor and review count in compact mode */}
									{!compact && (
										<div className="flex flex-col">
											<span className="font-medium text-sm">
												{getRatingDescriptor(result.rating.value)}
											</span>
											{result.rating.count && (
												<span className="text-muted-foreground text-xs">
													{result.rating.count.toLocaleString()} reviews
												</span>
											)}
										</div>
									)}
								</>
							) : (
								<>
									{/* Star style (default) - using premium Amber badge */}
									<Badge
										variant="rating"
										size="sm"
										className={cn(
											"font-bold",
											compact ? "px-1 py-0 text-[11px]" : "px-1.5",
										)}
									>
										<span className={compact ? "mr-0.5" : "mr-1"}>
											{result.rating.value.toFixed(1)}
										</span>
										<Star
											className={
												compact
													? "h-2.5 w-2.5 fill-current"
													: "h-3 w-3 fill-current"
											}
										/>
									</Badge>
									{/* Hide review count in compact mode */}
									{!compact && result.rating.count && (
										<span className="text-muted-foreground text-xs">
											({result.rating.count.toLocaleString()})
										</span>
									)}
								</>
							)}
						</div>
					)}

					{/* Features/Amenities - hidden in compact mode */}
					{!compact && result.features?.length ? (
						<div className="flex flex-wrap gap-x-3 gap-y-1">
							{result.features?.slice(0, 4).map((feature) => {
								const IconComponent = feature.icon
									? FEATURE_ICONS[feature.icon.toLowerCase()]
									: null;
								return (
									<span
										key={feature.label}
										className="inline-flex items-center gap-1 text-muted-foreground text-xs"
									>
										{IconComponent && <IconComponent className="h-3 w-3" />}
										{feature.label}
									</span>
								);
							})}
						</div>
					) : null}

					{/* Shipping & Delivery Info - hidden in compact mode */}
					{!compact && (result.shipping || result.stock) && (
						<div className="space-y-1.5">
							<ShippingInfo
								cost={result.shipping?.cost}
								free={result.shipping?.free}
								currency={result.shipping?.currency ?? currency}
								minDays={result.shipping?.minDays}
								maxDays={result.shipping?.maxDays}
							/>
							{/* Stock status badge */}
							{result.stock?.status && (
								<span
									className={cn(
										"inline-flex items-center gap-1 text-xs",
										result.stock.status === "in_stock" && "text-success",
										result.stock.status === "limited" && "text-warning",
										result.stock.status === "out_of_stock" &&
											"text-destructive",
									)}
								>
									{result.stock.status === "in_stock" && (
										<>
											<CheckCircle className="h-3 w-3" />
											In Stock
										</>
									)}
									{result.stock.status === "limited" && (
										<>
											<Package className="h-3 w-3" />
											Limited Stock
										</>
									)}
									{result.stock.status === "out_of_stock" && (
										<>
											<Package className="h-3 w-3" />
											Out of Stock
										</>
									)}
								</span>
							)}
						</div>
					)}

					{/* Offer Count - hidden in compact mode */}
					{!compact && result.offerCount && result.offerCount > 1 && (
						<OfferCountBadge count={result.offerCount} />
					)}
				</div>

				{/* Bottom section: Price + CTA (pushed to bottom with mt-auto) */}
				<div
					className={cn(
						"mt-auto",
						compact ? "space-y-2 pt-2.5" : "space-y-3 pt-3",
					)}
				>
					{/* Price - simplified in compact mode */}
					<div className="flex items-baseline justify-between">
						<div>
							{result.price?.amount != null ? (
								<>
									<div className="flex items-baseline gap-1">
										{/* Hide prefix in compact mode */}
										{!compact && pricePrefix && (
											<span className="text-muted-foreground text-sm">
												{pricePrefix}
											</span>
										)}
										<div className="flex items-center gap-2">
											<span
												className={cn(
													"font-bold",
													compact ? "text-lg" : "text-2xl",
													isBestPrice && "text-success",
												)}
											>
												{result.price.formatted ||
													formatPrice(
														result.price.amount,
														currency as CurrencyCode,
													)}
											</span>
											{/* Hide trend icons in compact mode */}
											{!compact && priceTrend === "down" && (
												<TrendingDown className="h-4 w-4 text-success" />
											)}
											{!compact && priceTrend === "up" && (
												<TrendingUp className="h-4 w-4 text-destructive" />
											)}
										</div>
										{/* Hide unit in compact mode */}
										{!compact && priceUnit && (
											<span className="text-muted-foreground text-sm">
												{priceUnit}
											</span>
										)}
									</div>
									{/* Hide original price in compact mode */}
									{!compact && result.price?.original && (
										<p className="text-muted-foreground text-sm line-through">
											{formatPrice(
												result.price.original,
												currency as CurrencyCode,
											)}
										</p>
									)}
									{/* Hide tax note in compact mode */}
									{!compact && showTaxNote && (
										<p className="text-muted-foreground text-xs">
											Includes taxes and fees
										</p>
									)}
								</>
							) : (
								<span className="text-muted-foreground text-sm">
									Price not available
								</span>
							)}
						</div>
						{/* Hide Best Price badge in compact mode */}
						{!compact && isBestPrice && result.price?.amount != null && (
							<Badge variant="success" size="sm">
								Best Price
							</Badge>
						)}
					</div>

					{/* Actions - single button: View Details */}
					<div className={cn("flex gap-2", compact ? "pt-1" : "pt-2")}>
						{/* View Details button - opens product detail dialog */}
						<Button
							variant="outline"
							size={compact ? "sm" : "default"}
							className="flex-1"
							onClick={(e) => {
								e.stopPropagation();
								onItemClick?.();
							}}
						>
							{detailsLabel}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
