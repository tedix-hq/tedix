"use client";

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/utils";

export const cardVariants = cva(
	// Base: subtle shadow for elevation (matches live AI apps like TheFork/Booking)
	"group/card flex flex-col overflow-hidden rounded-xl bg-card text-card-foreground text-sm shadow-sm ring-1 ring-foreground/5 has-[>img:first-child]:pt-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
	{
		variants: {
			size: {
				default: "gap-6 py-6",
				sm: "gap-4 py-4",
			},
			clickable: {
				true: "cursor-pointer transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]",
				false: "",
			},
			selected: {
				true: "shadow-lg ring-2 ring-primary",
				false: "",
			},
			elevated: {
				true: "shadow-md",
				false: "",
			},
			disableHoverScale: {
				true: "",
				false: "",
			},
		},
		defaultVariants: {
			size: "default",
			clickable: false,
			selected: false,
			elevated: false,
			disableHoverScale: false,
		},
		compoundVariants: [
			{
				clickable: true,
				disableHoverScale: false,
				className: "hover:scale-[1.02] hover:shadow-md",
			},
		],
	},
);

export interface CardProps
	extends React.ComponentProps<"div">, VariantProps<typeof cardVariants> {
	/** Make card clickable with hover/press effects */
	clickable?: boolean;
	/** Show selected state (ring highlight) */
	selected?: boolean;
	/** Show elevated state with stronger shadow (use for featured/promoted cards) */
	elevated?: boolean;
	/** Disable hover scale animation */
	disableHoverScale?: boolean;
}

/**
 * Card - A container component with consistent styling
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Card Title</CardTitle>
 *     <CardDescription>Card description text</CardDescription>
 *   </CardHeader>
 *   <CardContent>
 *     <p>Card content goes here</p>
 *   </CardContent>
 *   <CardFooter>
 *     <Button>Action</Button>
 *   </CardFooter>
 * </Card>
 * ```
 *
 * @example Interactive card
 * ```tsx
 * <Card onClick={() => console.log('Clicked')}>
 *   <CardContent>Click me!</CardContent>
 * </Card>
 * ```
 *
 * @example Selectable card
 * ```tsx
 * <Card selected onClick={() => setSelected(!selected)}>
 *   <CardContent>Toggle selection</CardContent>
 * </Card>
 * ```
 *
 */
function Card({
	className,
	size,
	clickable,
	selected,
	elevated,
	onClick,
	onKeyDown,
	tabIndex,
	role,
	disableHoverScale,
	...props
}: CardProps) {
	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		onKeyDown?.(e);
		if (onClick && (e.key === "Enter" || e.key === " ")) {
			e.preventDefault();
			e.currentTarget.click();
		}
	};

	const isInteractive = clickable || !!onClick;

	// Allow custom role/tabIndex override, otherwise use defaults for interactive cards
	const effectiveRole = role ?? (isInteractive ? "button" : undefined);
	const effectiveTabIndex = tabIndex ?? (isInteractive ? 0 : undefined);

	return (
		<div
			data-slot="card"
			className={cn(
				cardVariants({
					size,
					clickable,
					selected,
					elevated,
					disableHoverScale,
				}),
				className,
			)}
			role={effectiveRole}
			tabIndex={effectiveTabIndex}
			onClick={onClick}
			onKeyDown={isInteractive ? handleKeyDown : undefined}
			aria-pressed={
				isInteractive && selected !== undefined ? selected : undefined
			}
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-header"
			className={cn(
				"group/card-header @container/card-header grid auto-rows-min items-start gap-2 rounded-t-xl px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] group-data-[size=sm]/card:px-4 [.border-b]:pb-6 group-data-[size=sm]/card:[.border-b]:pb-4",
				className,
			)}
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-title"
			className={cn("font-medium text-base", className)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-description"
			className={cn("text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-action"
			className={cn(
				"col-start-2 row-span-2 row-start-1 self-start justify-self-end",
				className,
			)}
			{...props}
		/>
	);
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-content"
			className={cn("px-6 group-data-[size=sm]/card:px-4", className)}
			{...props}
		/>
	);
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			className={cn(
				"flex items-center rounded-b-xl px-6 group-data-[size=sm]/card:px-4 [.border-t]:pt-6 group-data-[size=sm]/card:[.border-t]:pt-4",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * CardActions - Container for action buttons
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Title</CardTitle>
 *   </CardHeader>
 *   <CardContent>Content</CardContent>
 *   <CardActions>
 *     <Button>Primary</Button>
 *     <Button variant="outline">Secondary</Button>
 *   </CardActions>
 * </Card>
 * ```
 */
function CardActions({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-actions"
			className={cn(
				"flex flex-wrap items-center gap-2 rounded-b-xl px-6 group-data-[size=sm]/card:px-4 [.border-t]:pt-6 group-data-[size=sm]/card:[.border-t]:pt-4",
				className,
			)}
			{...props}
		/>
	);
}

export interface CardImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
	/** Fallback image if src fails to load */
	fallback?: string;
	/** Aspect ratio preset */
	aspectRatio?: "square" | "video" | "portrait" | "auto";
	/** Object fit behavior */
	objectFit?: "cover" | "contain" | "fill" | "none";
	/** Show loading state */
	showLoading?: boolean;
}

const aspectRatioClasses = {
	square: "aspect-square",
	video: "aspect-video",
	portrait: "aspect-[3/4]",
	auto: "",
};

/**
 * CardImage - Image with loading states optimized for cards
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardImage
 *     src="/image.jpg"
 *     alt="Product"
 *     aspectRatio="square"
 *   />
 *   <CardHeader>
 *     <CardTitle>Product Name</CardTitle>
 *   </CardHeader>
 * </Card>
 * ```
 */
function CardImage({
	className,
	src,
	alt = "",
	fallback = "/placeholder.svg",
	aspectRatio = "auto",
	objectFit = "cover",
	showLoading = true,
	...props
}: CardImageProps) {
	const [isLoading, setIsLoading] = React.useState(true);
	const [hasError, setHasError] = React.useState(false);

	const handleLoad = () => {
		setIsLoading(false);
	};

	const handleError = () => {
		setIsLoading(false);
		setHasError(true);
	};

	const imageSrc = hasError ? fallback : src;

	return (
		<div
			data-slot="card-image"
			className={cn(
				"relative overflow-hidden bg-muted",
				aspectRatioClasses[aspectRatio],
				className,
			)}
		>
			{showLoading && isLoading && (
				<div className="absolute inset-0 animate-pulse bg-muted" />
			)}
			<img
				src={imageSrc}
				alt={alt}
				onLoad={handleLoad}
				onError={handleError}
				className={cn(
					"h-full w-full transition-opacity duration-300",
					objectFit === "cover" && "object-cover",
					objectFit === "contain" && "object-contain",
					objectFit === "fill" && "object-fill",
					objectFit === "none" && "object-none",
					isLoading ? "opacity-0" : "opacity-100",
				)}
				{...props}
			/>
		</div>
	);
}

// Attach compound components to Card
const CardWithCompounds = Object.assign(Card, {
	Header: CardHeader,
	Footer: CardFooter,
	Title: CardTitle,
	Action: CardAction,
	Description: CardDescription,
	Content: CardContent,
	Actions: CardActions,
	Image: CardImage,
});

export {
	CardWithCompounds as Card,
	CardHeader,
	CardFooter,
	CardTitle,
	CardAction,
	CardDescription,
	CardContent,
	CardActions,
	CardImage,
};
