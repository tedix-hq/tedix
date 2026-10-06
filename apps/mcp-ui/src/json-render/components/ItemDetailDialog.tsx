import { useStateValue } from "@json-render/react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@tedix/widget-ui/dialog";
import { Badge } from "@tedix/widget-ui/badge";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import { useWidgetOpenExternal } from "../../lib/widget-host-hooks";
import { safeImageSrc } from "@tedix/widget-ui/safe-url";
import { safeTrackedHref, type UtmParams } from "../../lib/utm";
import { StarRating } from "./StarRating";

interface ItemDetailDialogProps {
	item: Record<string, unknown> | null;
	onClose: () => void;
}

export function ItemDetailDialogComponent({
	item,
	onClose,
}: ItemDetailDialogProps) {
	const utmParams = useStateValue<UtmParams>("/_utmParams");
	const openExternal = useWidgetOpenExternal(utmParams);
	if (!item) return null;

	const typedItem = item as unknown as LayoutItem;
	const {
		title,
		image,
		price,
		rating,
		url,
		description,
		badge: rawBadge,
		offers: rawOffers,
	} = typedItem;
	const brand = typedItem.metadata?.brand as string | undefined;
	const source = typedItem.metadata?.source as string | undefined;
	const badge = rawBadge?.text;
	const badgeVariant = rawBadge?.variant;
	const offers = rawOffers
		? [...rawOffers].sort((a, b) => a.price - b.price)
		: [];
	const hasOffers = offers.length > 0;

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="text-lg pr-6">
						{title ?? "Product Details"}
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-4">
					{image && (
						<div className="relative overflow-hidden rounded-lg bg-muted">
							<img
								src={safeImageSrc(image)}
								alt={title ?? ""}
								className="w-full object-contain max-h-[300px]"
							/>
							{badge && (
								<div className="absolute top-2 left-2">
									<Badge variant={badgeVariant}>{badge}</Badge>
								</div>
							)}
						</div>
					)}

					<div className="space-y-2">
						{brand && <p className="text-sm text-muted-foreground">{brand}</p>}

						{rating && <StarRating value={rating.value} count={rating.count} />}

						{price && (
							<div className="flex items-baseline gap-2">
								<span className="text-2xl font-bold">
									{price.formatted ?? `${price.currency} ${price.amount}`}
								</span>
							</div>
						)}

						{description && (
							<p className="text-sm text-muted-foreground leading-relaxed">
								{description}
							</p>
						)}

						{source && (
							<p className="text-xs text-muted-foreground">Source: {source}</p>
						)}
					</div>

					{hasOffers ? (
						<div className="space-y-2">
							<p className="text-sm font-medium text-muted-foreground">
								{offers.length} {offers.length === 1 ? "offer" : "offers"} —
								lowest price first
							</p>
							{offers.map((offer, i) => {
								const {
									url: offerUrl,
									price: offerPrice,
									currency: offerCurrency,
									merchantName,
									merchantLogo,
									shippingCost: shipping,
									deliveryDays: days,
									merchantId,
								} = offer;
								const fullUrl = safeTrackedHref(offerUrl, utmParams);
								return (
									<div
										key={merchantId ?? `offer-${i}`}
										className="flex items-center justify-between gap-3 rounded-lg border p-3"
									>
										<div className="flex items-center gap-2 min-w-0">
											{merchantLogo && (
												<img
													src={safeImageSrc(merchantLogo)}
													alt=""
													className="size-5 rounded object-contain shrink-0"
												/>
											)}
											<div className="min-w-0">
												<p className="text-sm font-medium truncate">
													{merchantName}
												</p>
												{(shipping != null || days != null) && (
													<p className="text-xs text-muted-foreground">
														{shipping != null && shipping > 0
															? `+${offerCurrency} ${shipping.toFixed(2)} shipping`
															: "Free shipping"}
														{days != null && ` · ${days}d`}
													</p>
												)}
											</div>
										</div>
										<div className="flex items-center gap-2 shrink-0">
											<span className="text-sm font-bold">
												{offerCurrency} {offerPrice.toFixed(2)}
											</span>
											{fullUrl && (
												<a
													href={fullUrl}
													target="_blank"
													rel="noopener noreferrer"
													onClick={(e) => {
														e.preventDefault();
														openExternal(fullUrl);
													}}
													className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors whitespace-nowrap"
												>
													Buy →
												</a>
											)}
										</div>
									</div>
								);
							})}
						</div>
					) : url ? (
						<a
							href={safeTrackedHref(url, utmParams)}
							target="_blank"
							rel="noopener noreferrer"
							onClick={(e) => {
								e.preventDefault();
								openExternal(url);
							}}
							className="block w-full rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						>
							View on Store →
						</a>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
