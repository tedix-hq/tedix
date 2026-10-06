"use client";

import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";
import type { StatefulComponentProps } from "../types/stateful-component-props";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";
import { Skeleton } from "./skeleton";

export interface Photo {
	/** Unique identifier */
	id: string;
	/** Photo URL */
	url: string;
	/** Photo title */
	title?: string;
	/** Alt text for accessibility */
	alt?: string;
	/** Photo caption */
	caption?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

export interface PhotoCarouselProps extends StatefulComponentProps {
	/**
	 * Array of image URLs or Photo objects to display in the carousel
	 */
	images: string[] | Photo[];

	/**
	 * Aspect ratio for photos (CSS aspect-ratio value)
	 * @default '16/9'
	 */
	aspectRatio?: "16/9" | "4/3" | "1/1" | "21/9" | "3/2" | "2/3";

	/**
	 * Show navigation dots at bottom
	 * @default true
	 */
	showDots?: boolean;

	/**
	 * Show previous/next arrow buttons
	 * @default true
	 */
	showArrows?: boolean;

	/**
	 * Enable infinite looping
	 * @default false
	 */
	loop?: boolean;

	/**
	 * Optional top overlay content (e.g., branding, logo)
	 */
	topOverlay?: React.ReactNode;

	/**
	 * Optional bottom overlay content (e.g., caption)
	 */
	bottomOverlay?: React.ReactNode;

	/**
	 * Empty state message
	 */
	emptyMessage?: string;

	/**
	 * Callback when photo index changes
	 */
	onSlideChange?: (index: number) => void;

	/**
	 * Callback when an image is clicked
	 */
	onImageClick?: (index: number) => void;

	/**
	 * Additional CSS class name
	 */
	className?: string;
}

/**
 * PhotoCarousel - Embla-based photo carousel with navigation dots and arrows.
 * Lightweight component for inline photo viewing (not fullscreen).
 *
 * @example
 * ```tsx
 * <PhotoCarousel
 *   images={['photo1.jpg', 'photo2.jpg', 'photo3.jpg']}
 *   aspectRatio="16/9"
 *   topOverlay={
 *     <img src="logo.png" alt="Agency" style={{ height: 24 }} />
 *   }
 * />
 * ```
 */
export function PhotoCarousel({
	images,
	aspectRatio = "16/9",
	showDots = true,
	showArrows = true,
	loop = false,
	topOverlay,
	bottomOverlay,
	isLoading = false,
	error,
	isEmpty = false,
	onRetry,
	emptyMessage = "No photos available",
	onSlideChange,
	onImageClick,
	className,
}: PhotoCarouselProps) {
	const [emblaRef, emblaApi] = useEmblaCarousel({ loop, skipSnaps: false });
	const [selectedIndex, setSelectedIndex] = React.useState(0);

	// Handle slide selection
	const onSelect = React.useCallback(() => {
		if (!emblaApi) return;
		const index = emblaApi.selectedScrollSnap();
		setSelectedIndex(index);
		onSlideChange?.(index);
	}, [emblaApi, onSlideChange]);

	// Subscribe to embla select events
	React.useEffect(() => {
		if (!emblaApi) return;
		onSelect();
		emblaApi.on("select", onSelect);
		return () => {
			emblaApi.off("select", onSelect);
		};
	}, [emblaApi, onSelect]);

	// Navigation functions
	const scrollPrev = React.useCallback(
		() => emblaApi?.scrollPrev(),
		[emblaApi],
	);
	const scrollNext = React.useCallback(
		() => emblaApi?.scrollNext(),
		[emblaApi],
	);
	const scrollTo = React.useCallback(
		(index: number) => emblaApi?.scrollTo(index),
		[emblaApi],
	);

	// Normalize images to array of strings
	const imageUrls = React.useMemo(() => {
		if (!images) return [];
		return images.map((img) => (typeof img === "string" ? img : img.url));
	}, [images]);

	// Loading state
	if (isLoading) {
		return (
			<div
				data-slot="photo-carousel"
				className={cn(
					"relative w-full overflow-hidden rounded-xl bg-secondary",
					className,
				)}
				style={{ aspectRatio }}
			>
				<Skeleton className="h-full w-full" />
			</div>
		);
	}

	// Error state
	if (error) {
		return (
			<div
				data-slot="photo-carousel"
				className={cn(
					"relative w-full overflow-hidden rounded-xl bg-secondary",
					className,
				)}
				style={{ aspectRatio }}
			>
				<div className="absolute inset-0 flex items-center justify-center p-4">
					<Alert color="danger" variant="soft">
						<AlertTitle>Error loading photos</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
						{onRetry && (
							<Button
								variant="outline"
								size="sm"
								onClick={onRetry}
								className="mt-2"
							>
								Retry
							</Button>
						)}
					</Alert>
				</div>
			</div>
		);
	}

	// Empty state
	if (isEmpty || !imageUrls || imageUrls.length === 0) {
		return (
			<div
				data-slot="photo-carousel"
				className={cn(
					"relative w-full overflow-hidden rounded-xl bg-secondary",
					className,
				)}
				style={{ aspectRatio }}
			>
				<div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
					{emptyMessage}
				</div>
			</div>
		);
	}

	const hasPrev = !loop && selectedIndex > 0;
	const hasNext = !loop && selectedIndex < imageUrls.length - 1;

	return (
		<div
			data-slot="photo-carousel"
			className={cn(
				"relative w-full overflow-hidden rounded-xl bg-secondary",
				className,
			)}
			style={{ aspectRatio }}
		>
			{/* Embla Carousel */}
			<div className="h-full w-full overflow-hidden" ref={emblaRef}>
				<div className="flex h-full">
					{imageUrls.map((image, index) => (
						<div
							key={index}
							className="relative min-w-0 flex-[0_0_100%]"
							onClick={() => onImageClick?.(index)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onImageClick?.(index);
								}
							}}
							role={onImageClick ? "button" : undefined}
							tabIndex={onImageClick ? 0 : undefined}
							style={{ cursor: onImageClick ? "pointer" : undefined }}
						>
							<img
								src={image}
								alt={`Photo ${index + 1} of ${imageUrls.length}`}
								className="block h-full w-full object-cover"
								loading="lazy"
							/>
						</div>
					))}
				</div>
			</div>

			{/* Top Overlay (branding, logo, etc.) */}
			{topOverlay && (
				<div className="pointer-events-none absolute top-0 right-0 left-0 z-[2] [&>*]:pointer-events-auto">
					{topOverlay}
				</div>
			)}

			{/* Bottom Overlay (caption, etc.) */}
			{bottomOverlay && (
				<div className="pointer-events-none absolute right-0 bottom-0 left-0 z-[2] [&>*]:pointer-events-auto">
					{bottomOverlay}
				</div>
			)}

			{/* Navigation Arrows */}
			{showArrows && imageUrls.length > 1 && (
				<>
					{(loop || hasPrev) && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={scrollPrev}
							aria-label="Previous photo"
							className={cn(
								"absolute top-1/2 left-4 z-[3] -translate-y-1/2",
								"rounded-full",
								"bg-background/90 shadow-md hover:bg-background",
								"transition-all duration-150",
							)}
						>
							<ChevronLeft className="h-4 w-4" />
						</Button>
					)}
					{(loop || hasNext) && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={scrollNext}
							aria-label="Next photo"
							className={cn(
								"absolute top-1/2 right-4 z-[3] -translate-y-1/2",
								"rounded-full",
								"bg-background/90 shadow-md hover:bg-background",
								"transition-all duration-150",
							)}
						>
							<ChevronRight className="h-4 w-4" />
						</Button>
					)}
				</>
			)}

			{/* Navigation Dots */}
			{showDots && imageUrls.length > 1 && (
				<div className="absolute right-0 bottom-4 left-0 z-[3] flex items-center justify-center gap-2">
					{imageUrls.map((_, index) => (
						<button
							key={index}
							className={cn(
								"h-2 w-2 rounded-full border-none p-0 transition-all duration-200",
								"cursor-pointer bg-background shadow-sm",
								index === selectedIndex
									? "h-2.5 w-2.5 opacity-100"
									: "opacity-60 hover:scale-110 hover:opacity-85",
							)}
							onClick={() => scrollTo(index)}
							aria-label={`Go to photo ${index + 1}`}
							aria-current={index === selectedIndex ? "true" : "false"}
							type="button"
						/>
					))}
				</div>
			)}
		</div>
	);
}
