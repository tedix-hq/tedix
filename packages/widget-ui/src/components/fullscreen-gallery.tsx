"use client";

import { AnimatePresence, motion } from "motion/react";
import { Grid3X3, X } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";
import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import { Button } from "./button";
import { Skeleton } from "./skeleton";

// =============================================================================
// Types
// =============================================================================

export interface FullscreenGalleryProps<T extends LayoutItem> {
	/** Array of items to display */
	items: T[];

	/** Initial selected item index */
	initialIndex?: number;

	/** Callback when gallery is closed */
	onClose?: () => void;

	/** Callback when an item is selected */
	onItemSelect?: (item: T, index: number) => void;

	/** Custom item renderer for grid view */
	renderItem?: (item: T, index: number) => React.ReactNode;

	/** Gallery title */
	title?: string;

	/** Show item count in header */
	showCount?: boolean;

	/** Enable keyboard navigation */
	enableKeyboardNav?: boolean;

	/** Loading state */
	isLoading?: boolean;

	/** Custom className */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * FullscreenGallery - Immersive fullscreen browsing experience
 *
 * A dedicated fullscreen component for browsing items in a responsive grid.
 *
 * **Features:**
 * - Responsive grid (1-4 columns based on viewport)
 * - Keyboard navigation (escape)
 * - Smooth animations between views
 * - Loading state with skeletons
 * - Custom renderers for items
 *
 * @example
 * ```tsx
 * <FullscreenGallery
 *   items={products}
 *   title="Search Results"
 *   onClose={() => requestDisplayMode('inline')}
 *   renderItem={(item) => <ProductCard {...item} />}
 * />
 * ```
 */
export function FullscreenGallery<T extends LayoutItem>({
	items,
	initialIndex = 0,
	onClose,
	onItemSelect,
	renderItem,
	title,
	showCount = true,
	enableKeyboardNav = true,
	isLoading = false,
	className,
}: FullscreenGalleryProps<T>) {
	const [selectedIndex, setSelectedIndex] = React.useState(initialIndex);
	const containerRef = React.useRef<HTMLDivElement>(null);

	// Keyboard navigation
	React.useEffect(() => {
		if (!enableKeyboardNav) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose?.();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [enableKeyboardNav, onClose]);

	// Focus container on mount for keyboard events
	React.useEffect(() => {
		containerRef.current?.focus();
	}, []);

	const handleItemClick = (item: T, index: number) => {
		setSelectedIndex(index);
		onItemSelect?.(item, index);
	};

	// Loading state
	if (isLoading) {
		return (
			<div
				className={cn(
					"fixed inset-0 z-[100] flex flex-col bg-background",
					className,
				)}
			>
				{/* Header skeleton */}
				<div className="flex items-center justify-between border-border border-b p-4">
					<Skeleton className="h-6 w-32" />
					<Skeleton className="h-8 w-8 rounded-full" />
				</div>

				{/* Grid skeleton */}
				<div className="flex-1 overflow-auto p-4">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
						{Array.from({ length: 8 }).map((_, i) => (
							<div key={i} className="space-y-3">
								<Skeleton className="aspect-[4/3] w-full rounded-lg" />
								<Skeleton className="h-4 w-3/4" />
								<Skeleton className="h-3 w-1/2" />
							</div>
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			className={cn(
				"fixed inset-0 z-[100] flex flex-col bg-background outline-none",
				className,
			)}
			data-slot="fullscreen-gallery"
		>
			{/* Header */}
			<header className="flex shrink-0 items-center justify-between border-border border-b px-4 py-3">
				<div className="flex items-center gap-3">
					{title && (
						<h1 className="font-semibold text-foreground text-lg">{title}</h1>
					)}

					{showCount && items.length > 0 && (
						<span className="text-muted-foreground text-sm">
							{`${items.length} items`}
						</span>
					)}
				</div>

				<div className="flex items-center gap-2">
					<Grid3X3 className="h-4 w-4 text-muted-foreground" />

					{/* Close button */}
					{onClose && (
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							aria-label="Close gallery"
						>
							<X className="h-5 w-5" />
						</Button>
					)}
				</div>
			</header>

			{/* Content */}
			<div className="relative min-h-0 flex-1 overflow-hidden">
				<AnimatePresence mode="wait">
					<motion.div
						key="grid"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
						className="h-full overflow-auto p-4"
					>
						<div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
							{items.map((item, index) => (
								<motion.div
									key={item.id}
									initial={{ opacity: 0, scale: 0.95 }}
									animate={{ opacity: 1, scale: 1 }}
									transition={{ delay: index * 0.02 }}
									className={cn(
										"cursor-pointer rounded-lg ring-2 ring-transparent transition-all hover:ring-primary/50",
										selectedIndex === index && "ring-primary",
									)}
									onClick={(e) => {
										// Don't trigger if clicking on interactive elements inside the rendered item
										const target = e.target as HTMLElement;
										if (
											target.closest("button") ||
											target.closest("a") ||
											target.closest('[role="button"]') ||
											target.closest("input") ||
											target.closest("label")
										) {
											return;
										}
										handleItemClick(item, index);
									}}
								>
									{renderItem ? (
										renderItem(item, index)
									) : (
										<DefaultGridItem item={item} />
									)}
								</motion.div>
							))}
						</div>
					</motion.div>
				</AnimatePresence>
			</div>

			{/* Navigation hints */}
			{enableKeyboardNav && (
				<div className="flex items-center justify-center gap-6 border-border border-t py-2 text-muted-foreground text-xs">
					<span>
						<kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
							Esc
						</kbd>{" "}
						Close
					</span>
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Default Renderers
// =============================================================================

function DefaultGridItem<T extends LayoutItem>({ item }: { item: T }) {
	return (
		<div className="overflow-hidden rounded-lg border border-border bg-card">
			<div className="aspect-[4/3] bg-muted">
				{item.image ? (
					<img
						src={item.image}
						alt={item.title}
						className="h-full w-full object-cover"
					/>
				) : (
					<div className="flex h-full items-center justify-center text-muted-foreground">
						No image
					</div>
				)}
			</div>
			<div className="p-3">
				<h3 className="line-clamp-1 font-medium text-sm">{item.title}</h3>
				{item.subtitle && (
					<p className="line-clamp-1 text-muted-foreground text-xs">
						{item.subtitle}
					</p>
				)}
				{item.price && (
					<p className="mt-1 font-semibold text-primary">
						{item.price.currency} {item.price.amount.toLocaleString()}
					</p>
				)}
			</div>
		</div>
	);
}

FullscreenGallery.displayName = "FullscreenGallery";
