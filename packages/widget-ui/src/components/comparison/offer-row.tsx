"use client";

import { CheckCircle, Clock, ExternalLink, Package, Truck } from "lucide-react";
import { type CurrencyCode, formatPrice } from "../../lib/price-utils";
import { cn } from "../../lib/utils";
import type { StockStatus } from "@tedix/api-contract/schemas/common";
import type { LayoutItemOfferSchemaType as LayoutItemOffer } from "@tedix/api-contract/schemas/layout";
import { Avatar } from "../avatar";
import { Badge } from "../badge";
import { Button } from "../button";

type OfferRowVariant = "carousel" | "dialog";

interface OfferRowProps {
	offer: LayoutItemOffer;
	currency: string;
	onExternalClick?: () => void;
	isLowestPrice?: boolean;
	variant?: OfferRowVariant;
}

function getStockDisplay(status?: StockStatus): {
	text: string;
	className: string;
	icon: typeof CheckCircle;
} | null {
	if (!status) return null;

	switch (status) {
		case "in_stock":
			return {
				text: "In Stock",
				className: "text-success",
				icon: CheckCircle,
			};
		case "limited":
			return {
				text: "Limited Stock",
				className: "text-warning",
				icon: Package,
			};
		case "out_of_stock":
			return {
				text: "Out of Stock",
				className: "text-destructive",
				icon: Package,
			};
		case "preorder":
			return {
				text: "Pre-order",
				className: "text-info",
				icon: Clock,
			};
		default:
			return null;
	}
}

const variantStyles: Record<
	OfferRowVariant,
	{
		container: string;
		topRowGap: string;
		avatarSize: number;
		avatarClassName?: string;
		priceText: string;
		infoGap: string;
		buttonClassName: string;
	}
> = {
	carousel: {
		container:
			"flex flex-col gap-2 rounded-lg border border-border bg-card/50 p-3 transition-colors hover:bg-muted/50",
		topRowGap: "gap-3",
		avatarSize: 32,
		priceText: "text-base",
		infoGap: "gap-2",
		buttonClassName: "min-h-9",
	},
	dialog: {
		container:
			"flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/50 sm:p-5",
		topRowGap: "gap-4",
		avatarSize: 40,
		avatarClassName: "shrink-0 rounded-md",
		priceText: "text-lg",
		infoGap: "gap-3",
		buttonClassName: "min-h-11 min-w-[80px] sm:min-h-0 sm:min-w-0",
	},
};

export function OfferRow({
	offer,
	currency,
	onExternalClick,
	isLowestPrice,
	variant = "carousel",
}: OfferRowProps) {
	const stockDisplay = getStockDisplay(offer.stockStatus);
	const isFreeShipping =
		offer.shippingCost === 0 || offer.shippingCost === undefined;
	const displayCurrency = (offer.currency || currency) as CurrencyCode;
	const styles = variantStyles[variant];
	const hasExternalAction = Boolean(onExternalClick);

	return (
		<div
			className={cn(
				styles.container,
				isLowestPrice && "ring-2 ring-success/40",
			)}
		>
			<div
				className={cn("flex items-center justify-between", styles.topRowGap)}
			>
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<Avatar
						imageUrl={offer.merchantLogo}
						name={offer.merchantName}
						size={styles.avatarSize}
						verified={offer.verified}
						className={styles.avatarClassName}
					/>
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium text-sm">{offer.merchantName}</p>
					</div>
				</div>

				<div className="text-right">
					<p
						className={cn(
							"font-bold",
							styles.priceText,
							isLowestPrice && "text-success",
						)}
					>
						{formatPrice(offer.price, displayCurrency)}
					</p>
					{isLowestPrice && (
						<Badge variant="success" size="sm" className="mt-0.5">
							Best Price
						</Badge>
					)}
				</div>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<div
					className={cn("flex flex-wrap items-center text-xs", styles.infoGap)}
				>
					{isFreeShipping ? (
						<span className="inline-flex items-center gap-1 font-medium text-success">
							<Truck className="size-3" />
							Free Shipping
						</span>
					) : offer.shippingCost != null ? (
						<span className="inline-flex items-center gap-1 text-muted-foreground">
							<Truck className="size-3" />+
							{formatPrice(offer.shippingCost, displayCurrency)}
						</span>
					) : null}

					{offer.deliveryDays != null && (
						<span className="inline-flex items-center gap-1 text-muted-foreground">
							<Clock className="size-3" />
							{offer.deliveryDays === 1
								? "1 day"
								: `${offer.deliveryDays} days`}
						</span>
					)}

					{stockDisplay && (
						<span
							className={cn(
								"inline-flex items-center gap-1",
								stockDisplay.className,
							)}
						>
							<stockDisplay.icon className="size-3" />
							{stockDisplay.text}
						</span>
					)}
				</div>

				{hasExternalAction && (
					<Button
						size="sm"
						variant="outline"
						onClick={onExternalClick}
						disabled={offer.stockStatus === "out_of_stock"}
						className={styles.buttonClassName}
						aria-label={`View offer from ${offer.merchantName}`}
					>
						View
						<ExternalLink className="size-3" />
					</Button>
				)}
			</div>
		</div>
	);
}
