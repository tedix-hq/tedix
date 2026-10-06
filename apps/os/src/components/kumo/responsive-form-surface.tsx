import type { ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";

interface ResponsiveFormSurfaceProps {
	children: ReactNode;
	className?: string;
	contentClassName?: string;
	description: ReactNode;
	mobileDescription?: ReactNode;
	mobileOpen: boolean;
	onMobileOpenChange: (open: boolean) => void;
	title: ReactNode;
}

/**
 * Keeps secondary mutation forms fully available on desktop while using a
 * compact, labeled disclosure on phones. The content remains a single DOM
 * subtree so form state, field ids, and authority semantics never fork by
 * viewport.
 */
export function ResponsiveFormSurface({
	children,
	className,
	contentClassName,
	description,
	mobileDescription,
	mobileOpen,
	onMobileOpenChange,
	title,
}: ResponsiveFormSurfaceProps) {
	const isMobileLayout = useMediaQuery("(max-width: 767px)");
	const open = !isMobileLayout || mobileOpen;

	return (
		<Surface
			className={cn("overflow-hidden", className)}
			data-kumo-component="ResponsiveFormSurface"
			data-responsive-form-layout={isMobileLayout ? "mobile" : "desktop"}
			data-responsive-form-state={open ? "open" : "closed"}
			render={<Collapsible open={open} onOpenChange={onMobileOpenChange} />}
		>
			<CollapsibleTrigger className="w-full justify-between rounded-lg px-4 py-3 text-left md:hidden">
				<span className="min-w-0">
					<span className="block font-medium text-kumo-default">{title}</span>
					<span className="block text-kumo-subtle type-tedix-label">
						{mobileDescription ?? description}
					</span>
				</span>
				<CaretDown
					aria-hidden
					className={cn(
						"size-4 shrink-0 transition-transform duration-tedix-standard motion-reduce:transition-none",
						mobileOpen && "rotate-180",
					)}
				/>
			</CollapsibleTrigger>
			<div className="hidden p-4 md:block">
				<Text weight="medium">{title}</Text>
				<Text tone="secondary">{description}</Text>
			</div>
			<CollapsibleContent keepMounted>
				<div
					className={cn(
						"border-kumo-line border-t p-4 md:border-t-0 md:pt-0",
						contentClassName,
					)}
				>
					{children}
				</div>
			</CollapsibleContent>
		</Surface>
	);
}
