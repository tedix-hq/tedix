import { useStateValue } from "@json-render/react";
import type { MouseEvent } from "react";
import { useWidgetOpenExternal } from "../../lib/widget-host-hooks";
import { safeImageSrc } from "@tedix/widget-ui/safe-url";
import { safeTrackedHref, type UtmParams } from "../../lib/utm";

interface ContentCardProps {
	title: string;
	snippet?: string | null;
	thumbnail?: string | null;
	category?: string | null;
	author?: string | null;
	date?: string | null;
	url?: string | null;
	score?: number | null;
	onClick?: (event: MouseEvent<HTMLAnchorElement | HTMLDivElement>) => void;
	shouldPreventDefault?: boolean;
}

export function ContentCardComponent({
	title,
	snippet,
	thumbnail,
	category,
	author,
	date,
	url,
	score,
	onClick,
	shouldPreventDefault,
}: ContentCardProps) {
	const utmParams = useStateValue<UtmParams>("/_utmParams");
	const openExternal = useWidgetOpenExternal(utmParams);
	// A URL the allowlist rejects degrades the card to a plain <div>: not a
	// link at all, rather than an <a> with a dropped href that still looks
	// clickable.
	const resolvedUrl = safeTrackedHref(url, utmParams);
	const Wrapper = resolvedUrl ? "a" : "div";
	const wrapperProps = resolvedUrl
		? {
				href: resolvedUrl,
				target: "_blank" as const,
				rel: "noopener noreferrer",
			}
		: {};

	return (
		<Wrapper
			{...wrapperProps}
			onClick={(event) => {
				if (shouldPreventDefault) {
					event.preventDefault();
					onClick?.(event);
					return;
				}
				if (resolvedUrl) {
					event.preventDefault();
					onClick?.(event);
					openExternal(resolvedUrl);
					return;
				}
				onClick?.(event);
			}}
			className="flex gap-4 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
		>
			{thumbnail && (
				<img
					src={safeImageSrc(thumbnail)}
					alt=""
					className="h-20 w-20 flex-shrink-0 rounded-lg object-cover"
				/>
			)}
			<div className="min-w-0 flex-1">
				<h3 className="font-semibold text-primary line-clamp-2">{title}</h3>
				{snippet && (
					<p className="mt-1 text-sm text-muted-foreground line-clamp-2 leading-relaxed">
						{snippet}
					</p>
				)}
				<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
					{category && (
						<span className="rounded bg-muted px-2 py-0.5">{category}</span>
					)}
					{author && <span>by {author}</span>}
					{date && <span>{new Date(date).toLocaleDateString()}</span>}
					{score != null && (
						<span className="font-medium text-emerald-600 dark:text-emerald-400">
							{Math.round(score * 100)}% match
						</span>
					)}
				</div>
			</div>
		</Wrapper>
	);
}
