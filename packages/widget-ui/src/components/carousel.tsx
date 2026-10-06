import Autoplay from "embla-carousel-autoplay";
import useEmblaCarousel, {
	type UseEmblaCarouselType,
} from "embla-carousel-react";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";
import { AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/utils";
import type { StatefulComponentProps } from "../types/stateful-component-props";
import { Button } from "./button";
import { Skeleton } from "./skeleton";

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

type CarouselProps = StatefulComponentProps & {
	opts?: CarouselOptions;
	plugins?: CarouselPlugin;
	orientation?: "horizontal" | "vertical";
	setApi?: (api: CarouselApi) => void;
	/** Number of skeleton items to show (default: 3) */
	loadingItemCount?: number;
	/** Custom error title */
	errorTitle?: string;
	/** Custom empty title */
	emptyTitle?: string;
	/** Custom empty message */
	emptyMessage?: string;
	/** Show edge gradients to indicate more content (default: false) */
	showEdgeGradients?: boolean;
	/** Enable mouse wheel scrolling (default: false) */
	enableWheelGestures?: boolean;
	/** Enable momentum-based free scrolling without snap points (default: false) */
	dragFree?: boolean;
	/** Callback when the selected slide changes */
	onSlideChange?: (index: number) => void;
	/** Show/hide navigation arrows (default: true) */
	showNavigation?: boolean;
	/** Gap between slides as CSS value. @default "1rem" */
	gap?: string;
	/** Remove leading offset so first slide is flush with viewport edge (default: false) */
	flushStart?: boolean;
	/** Custom left/top inset when using flushStart (CSS value) */
	startInset?: string;
	// === Auto-play options ===
	/** Enable auto-play (default: false) */
	autoPlay?: boolean;
	/** Auto-play delay in milliseconds (default: 4000) */
	autoPlayDelay?: number;
	/** Stop auto-play on user interaction (default: true) */
	autoPlayStopOnInteraction?: boolean;
	/** Stop auto-play on mouse enter (default: true) */
	autoPlayStopOnMouseEnter?: boolean;
	// === Fullscreen support ===
	/**
	 * Callback when user requests fullscreen mode.
	 * The widget owner connects this callback to its host display-mode request.
	 */
	onRequestFullscreen?: () => void;
	/** Show fullscreen button in carousel (default: false, only shown if onRequestFullscreen is provided) */
	showFullscreenButton?: boolean;
	// === Accessibility ===
	/** Accessible label for the carousel region (improves screen reader experience) */
	"aria-label"?: string;
	/** ID of element that labels the carousel (alternative to aria-label) */
	"aria-labelledby"?: string;
};

type CarouselContextProps = {
	carouselRef: ReturnType<typeof useEmblaCarousel>[0];
	api: ReturnType<typeof useEmblaCarousel>[1];
	scrollPrev: () => void;
	scrollNext: () => void;
	canScrollPrev: boolean;
	canScrollNext: boolean;
	selectedIndex: number;
	scrollSnapCount: number;
	scrollTo: (index: number) => void;
	opts?: CarouselOptions;
	orientation?: "horizontal" | "vertical";
	isLoading?: boolean;
	loadingItemCount?: number;
	/** Error message to display (undefined/null = no error, ReactNode = error content shown) */
	error?: React.ReactNode;
	/** Custom error title */
	errorTitle?: string;
	onRetry?: () => void;
	isEmpty?: boolean;
	/** Custom empty title */
	emptyTitle?: string;
	emptyMessage?: string;
	showEdgeGradients?: boolean;
	showNavigation?: boolean;
	gap: string;
	flushStart?: boolean;
	startInset?: string;
	/** Fullscreen request handler */
	onRequestFullscreen?: () => void;
	/** Show fullscreen button */
	showFullscreenButton?: boolean;
};

const CarouselContext = React.createContext<CarouselContextProps | null>(null);

function useCarousel() {
	const context = React.useContext(CarouselContext);

	if (!context) {
		throw new Error("useCarousel must be used within a <Carousel />");
	}

	return context;
}

/**
 * CarouselSkeleton - Loading skeleton for carousel items
 */
function CarouselSkeleton({
	count = 3,
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement> & { count?: number }) {
	const { orientation } = useCarousel();

	return (
		<div
			data-slot="carousel-skeleton"
			className={cn(
				"flex",
				orientation === "horizontal" ? "flex-row gap-4" : "flex-col gap-4",
				className,
			)}
			{...props}
		>
			{Array.from({ length: count }).map((_, i) => (
				<div
					key={i}
					className={cn(
						"flex-shrink-0",
						orientation === "horizontal" ? "w-[280px]" : "w-full",
					)}
				>
					<div className="space-y-3 rounded-xl border border-border/60 bg-background p-4">
						<Skeleton className="h-40 w-full" />
						<Skeleton className="h-4 w-3/4" />
						<Skeleton className="h-3 w-1/2" />
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * CarouselError - Error state with retry button
 */
function CarouselError({
	error,
	errorTitle = "Something went wrong",
	onRetry,
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement> & {
	/** Error message to display (undefined/null = no error, ReactNode = error content shown) */
	error?: React.ReactNode;
	/** Custom error title */
	errorTitle?: string;
	onRetry?: () => void;
}) {
	return (
		<div
			data-slot="carousel-error"
			role="alert"
			className={cn(
				"flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-background p-8 text-center",
				className,
			)}
			{...props}
		>
			<AlertCircle className="h-8 w-8 text-destructive" />
			<div className="space-y-1 text-destructive">
				{typeof error === "string" ? (
					<>
						<h3 className="font-medium text-sm">{errorTitle}</h3>
						<p className="text-muted-foreground text-xs">{error}</p>
					</>
				) : (
					error || (
						<>
							<h3 className="font-medium text-sm">{errorTitle}</h3>
							<p className="text-muted-foreground text-xs">
								Failed to load content
							</p>
						</>
					)
				)}
			</div>
			{onRetry && (
				<Button variant="outline" size="sm" onClick={onRetry}>
					Try Again
				</Button>
			)}
		</div>
	);
}

/**
 * CarouselEmpty - Empty state message
 */
function CarouselEmpty({
	title,
	message = "No items to display",
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement> & {
	/** Custom empty title */
	title?: string;
	message?: string;
}) {
	return (
		<div
			data-slot="carousel-empty"
			className={cn(
				"flex min-h-[200px] flex-col items-center justify-center rounded-xl border border-border/60 bg-background p-8 text-center",
				className,
			)}
			{...props}
		>
			{title && (
				<h3 className="mb-1 font-medium text-foreground text-sm">{title}</h3>
			)}
			<p className="text-muted-foreground text-sm">{message}</p>
		</div>
	);
}

function Carousel({
	orientation = "horizontal",
	opts,
	setApi,
	plugins,
	className,
	children,
	isLoading = false,
	loadingItemCount = 3,
	error = null,
	errorTitle,
	onRetry,
	isEmpty = false,
	emptyTitle,
	emptyMessage,
	showEdgeGradients = false,
	enableWheelGestures = false,
	dragFree,
	onSlideChange,
	showNavigation = true,
	gap = "1rem",
	flushStart = false,
	startInset,
	// Auto-play options
	autoPlay = false,
	autoPlayDelay = 4000,
	autoPlayStopOnInteraction = true,
	autoPlayStopOnMouseEnter = true,
	// Fullscreen support
	onRequestFullscreen,
	showFullscreenButton = false,
	// Accessibility
	"aria-label": ariaLabel,
	"aria-labelledby": ariaLabelledBy,
	...props
}: React.HTMLAttributes<HTMLDivElement> & CarouselProps) {
	// Conditionally add WheelGesturesPlugin for mouse wheel scrolling
	const wheelPlugin = enableWheelGestures ? WheelGesturesPlugin() : undefined;

	// Conditionally add Autoplay plugin
	const autoPlayPlugin = autoPlay
		? Autoplay({
				delay: autoPlayDelay,
				stopOnInteraction: autoPlayStopOnInteraction,
				stopOnMouseEnter: autoPlayStopOnMouseEnter,
			})
		: undefined;

	const allPlugins = [
		...(plugins || []),
		...(wheelPlugin ? [wheelPlugin] : []),
		...(autoPlayPlugin ? [autoPlayPlugin] : []),
	];

	const mergedOpts: CarouselOptions = {
		...opts,
		axis: orientation === "horizontal" ? "x" : "y",
		dragFree: dragFree ?? opts?.dragFree,
	};

	const [carouselRef, api] = useEmblaCarousel(mergedOpts, allPlugins);
	const [canScrollPrev, setCanScrollPrev] = React.useState(false);
	const [canScrollNext, setCanScrollNext] = React.useState(false);
	const [selectedIndex, setSelectedIndex] = React.useState(0);
	const [scrollSnapCount, setScrollSnapCount] = React.useState(0);

	const onSelect = React.useCallback(
		(api: CarouselApi) => {
			if (!api) {
				return;
			}

			setCanScrollPrev(api.canScrollPrev());
			setCanScrollNext(api.canScrollNext());
			const newIndex = api.selectedScrollSnap();
			setSelectedIndex(newIndex);
			onSlideChange?.(newIndex);
		},
		[onSlideChange],
	);

	const scrollPrev = React.useCallback(() => {
		api?.scrollPrev();
	}, [api]);

	const scrollNext = React.useCallback(() => {
		api?.scrollNext();
	}, [api]);

	const scrollTo = React.useCallback(
		(index: number) => {
			api?.scrollTo(index);
		},
		[api],
	);

	const handleKeyDown = React.useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				scrollPrev();
			} else if (event.key === "ArrowRight") {
				event.preventDefault();
				scrollNext();
			}
		},
		[scrollPrev, scrollNext],
	);

	React.useEffect(() => {
		if (!api || !setApi) {
			return;
		}

		setApi(api);
	}, [api, setApi]);

	React.useEffect(() => {
		if (!api) {
			return;
		}

		onSelect(api);
		api.on("reInit", onSelect);
		api.on("select", onSelect);

		return () => {
			api?.off("select", onSelect);
		};
	}, [api, onSelect]);

	React.useEffect(() => {
		if (!api) return;
		const updateSnapCount = () =>
			setScrollSnapCount(api.scrollSnapList().length);
		updateSnapCount();
		api.on("reInit", updateSnapCount);
		return () => {
			api.off("reInit", updateSnapCount);
		};
	}, [api]);

	// State Priority: Loading > Error > Empty > Content
	const showLoading = isLoading;
	const showError = !isLoading && !!error;
	const showEmpty = !isLoading && !error && isEmpty;

	// Generate live region announcement for screen readers
	const slideAnnouncement =
		scrollSnapCount > 0
			? `Slide ${selectedIndex + 1} of ${scrollSnapCount}`
			: undefined;

	return (
		<CarouselContext.Provider
			value={{
				carouselRef,
				api: api,
				opts,
				orientation:
					orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
				scrollPrev,
				scrollNext,
				canScrollPrev,
				canScrollNext,
				selectedIndex,
				scrollSnapCount,
				scrollTo,
				isLoading,
				loadingItemCount,
				error,
				errorTitle,
				onRetry,
				isEmpty,
				emptyTitle,
				emptyMessage,
				showEdgeGradients,
				showNavigation,
				gap,
				flushStart,
				startInset,
				onRequestFullscreen,
				showFullscreenButton,
			}}
		>
			<div
				data-slot="carousel"
				onKeyDownCapture={handleKeyDown}
				className={cn("relative", className)}
				role="region"
				aria-roledescription="carousel"
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				{...props}
			>
				{/* Live region for screen reader announcements */}
				<div aria-live="polite" aria-atomic="true" className="sr-only">
					{slideAnnouncement}
				</div>
				{/* Loading State */}
				{showLoading && <CarouselSkeleton count={loadingItemCount} />}

				{/* Error State */}
				{showError && (
					<CarouselError
						error={error}
						errorTitle={errorTitle}
						onRetry={onRetry}
					/>
				)}

				{/* Empty State */}
				{showEmpty && (
					<CarouselEmpty title={emptyTitle} message={emptyMessage} />
				)}

				{/* Content */}
				{!showLoading && !showError && !showEmpty && (
					<>
						{/* Edge Gradients - subtle fade indicators */}
						{showEdgeGradients && orientation === "horizontal" && (
							<>
								{/* Left gradient */}
								{canScrollPrev && (
									<div
										className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 w-6 bg-gradient-to-r from-background/50 via-background/20 to-transparent"
										aria-hidden="true"
									/>
								)}
								{/* Right gradient */}
								{canScrollNext && (
									<div
										className="pointer-events-none absolute top-0 right-0 bottom-0 z-10 w-6 bg-gradient-to-l from-background/50 via-background/20 to-transparent"
										aria-hidden="true"
									/>
								)}
							</>
						)}

						{children}
					</>
				)}
			</div>
		</CarouselContext.Provider>
	);
}

function CarouselContent({
	className,
	style,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	const { carouselRef, orientation, gap, flushStart, startInset } =
		useCarousel();

	const marginStyle = flushStart
		? { marginLeft: startInset ? `-${startInset}` : undefined }
		: orientation === "horizontal"
			? { marginLeft: `-${gap}` }
			: { marginTop: `-${gap}` };

	return (
		<div
			ref={carouselRef}
			className="overflow-hidden"
			style={{ touchAction: "pan-y pinch-zoom" }}
		>
			<div
				data-slot="carousel-content"
				className={cn(
					"flex",
					orientation === "vertical" && "flex-col",
					className,
				)}
				style={{
					...marginStyle,
					gap,
					...style,
				}}
				{...props}
			/>
		</div>
	);
}

function CarouselItem({
	className,
	style,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	const { flushStart, startInset } = useCarousel();

	// When using CSS gap, we don't need padding on items
	// Only apply padding for first item when flushStart with startInset
	const paddingStyle =
		flushStart && startInset ? { paddingLeft: startInset } : undefined;

	return (
		<div
			data-slot="carousel-item"
			role="group"
			aria-roledescription="slide"
			className={cn("min-w-0 shrink-0 grow-0 basis-full", className)}
			style={{
				...paddingStyle,
				...style,
			}}
			{...props}
		/>
	);
}

function CarouselPrevious({
	className,
	variant = "outline",
	size = "icon",
	...props
}: React.ComponentProps<typeof Button>) {
	const { orientation, scrollPrev, canScrollPrev, showNavigation } =
		useCarousel();

	// Hide button entirely when navigation is disabled or can't scroll
	if (showNavigation === false || !canScrollPrev) return null;

	return (
		<Button
			data-slot="carousel-previous"
			variant={variant}
			size={size}
			className={cn(
				"absolute z-20 h-8 w-8 rounded-full border border-border bg-background shadow-sm hover:bg-muted",
				orientation === "horizontal"
					? "top-1/2 left-2 -translate-y-1/2"
					: "-top-12 left-1/2 -translate-x-1/2 rotate-90",
				className,
			)}
			onClick={scrollPrev}
			{...props}
		>
			<ChevronLeft className="h-4 w-4" />
			<span className="sr-only">Previous slide</span>
		</Button>
	);
}

function CarouselNext({
	className,
	variant = "outline",
	size = "icon",
	...props
}: React.ComponentProps<typeof Button>) {
	const { orientation, scrollNext, canScrollNext, showNavigation } =
		useCarousel();

	// Hide button entirely when navigation is disabled or can't scroll
	if (showNavigation === false || !canScrollNext) return null;

	return (
		<Button
			data-slot="carousel-next"
			variant={variant}
			size={size}
			className={cn(
				"absolute z-20 h-8 w-8 rounded-full border border-border bg-background shadow-sm hover:bg-muted",
				orientation === "horizontal"
					? "top-1/2 right-2 -translate-y-1/2"
					: "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
				className,
			)}
			onClick={scrollNext}
			{...props}
		>
			<ChevronRight className="h-4 w-4" />
			<span className="sr-only">Next slide</span>
		</Button>
	);
}

/**
 * CarouselDots - Pagination dots for carousel
 */
function CarouselDots({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	const { selectedIndex, scrollSnapCount, scrollTo } = useCarousel();

	if (scrollSnapCount <= 1) return null;

	return (
		<div
			data-slot="carousel-dots"
			className={cn("flex items-center justify-center gap-1.5 py-2", className)}
			{...props}
		>
			{Array.from({ length: scrollSnapCount }).map((_, index) => (
				<button
					key={index}
					type="button"
					className={cn(
						"h-2 w-2 rounded-full transition-all duration-200",
						index === selectedIndex
							? "w-4 bg-primary"
							: "bg-muted-foreground/30 hover:bg-muted-foreground/50",
					)}
					onClick={() => scrollTo(index)}
					aria-label={`Go to slide ${index + 1}`}
					aria-current={index === selectedIndex ? "true" : undefined}
				/>
			))}
		</div>
	);
}

export {
	type CarouselApi,
	Carousel,
	CarouselContent,
	CarouselItem,
	CarouselPrevious,
	CarouselNext,
	CarouselSkeleton,
	CarouselError,
	CarouselEmpty,
	CarouselDots,
	useCarousel,
};
