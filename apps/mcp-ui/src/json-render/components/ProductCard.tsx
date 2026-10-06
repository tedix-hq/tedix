import { useStateValue } from "@json-render/react";
import type { MouseEvent } from "react";
import { Card, CardContent } from "@tedix/widget-ui/card";
import { Badge } from "@tedix/widget-ui/badge";
import { useWidgetOpenExternal } from "../../lib/widget-host-hooks";
import { safeImageSrc } from "@tedix/widget-ui/safe-url";
import { safeTrackedHref, type UtmParams } from "../../lib/utm";
import { StarRating } from "./StarRating";

interface ProductCardProps {
	title: string;
	image?: string | null;
	price?: string | null;
	originalPrice?: string | null;
	rating?: number | null;
	ratingCount?: number | null;
	badge?: string | null;
	badgeVariant?:
		| "default"
		| "secondary"
		| "destructive"
		| "success"
		| "warning"
		| "outline"
		| null;
	url?: string | null;
	ctaLabel?: string | null;
	onCtaClick?: (
		event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
	) => void;
	ctaShouldPreventDefault?: boolean;
}

export function ProductCardComponent({
	title,
	image,
	price,
	originalPrice,
	rating,
	ratingCount,
	badge,
	badgeVariant,
	url,
	ctaLabel,
	onCtaClick,
	ctaShouldPreventDefault,
}: ProductCardProps) {
	const utmParams = useStateValue<UtmParams>("/_utmParams");
	const openExternal = useWidgetOpenExternal(utmParams);
	const resolvedUrl = safeTrackedHref(url, utmParams);
	const cta = ctaLabel ? (
		resolvedUrl ? (
			<a
				href={resolvedUrl}
				target="_blank"
				rel="noopener noreferrer"
				onClick={(event) => {
					if (ctaShouldPreventDefault) {
						event.preventDefault();
						onCtaClick?.(event);
						return;
					}
					event.preventDefault();
					onCtaClick?.(event);
					openExternal(url as string);
				}}
				className="mt-2 block w-full rounded-md bg-primary px-3 py-1.5 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
			>
				{ctaLabel}
			</a>
		) : (
			<button
				type="button"
				onClick={onCtaClick}
				className="mt-2 block w-full rounded-md bg-primary px-3 py-1.5 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
			>
				{ctaLabel}
			</button>
		)
	) : null;

	return (
		<Card className="flex-shrink-0 w-full snap-start overflow-hidden">
			{image && (
				<div className="relative">
					<img
						src={safeImageSrc(image)}
						alt={title}
						className="aspect-square w-full object-cover"
					/>
					{badge && (
						<div className="absolute top-2 left-2">
							<Badge variant={(badgeVariant as "default") ?? "default"}>
								{badge}
							</Badge>
						</div>
					)}
				</div>
			)}
			<CardContent className="p-3 space-y-1.5">
				<h3 className="font-medium text-sm text-foreground line-clamp-2">
					{title}
				</h3>
				{rating != null && (
					<StarRating
						value={rating}
						count={ratingCount}
						gap="gap-1"
						countSize="text-xs"
					/>
				)}
				<div className="flex items-baseline gap-2">
					{price && (
						<span className="text-lg font-bold text-foreground">{price}</span>
					)}
					{originalPrice && (
						<span className="text-sm text-muted-foreground line-through">
							{originalPrice}
						</span>
					)}
				</div>
				{cta}
			</CardContent>
		</Card>
	);
}
