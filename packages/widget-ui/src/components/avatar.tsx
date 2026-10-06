"use client";

/**
 * Avatar Component
 *
 * Aligned with OpenAI @openai/apps-sdk-ui Avatar component.
 *
 * apps-sdk-ui API (fully supported):
 * - className: Custom class names
 * - size: Avatar size in pixels (default: 32)
 * - name: Name used to generate initials
 * - imageUrl: URL of the avatar image
 * - Icon: Custom icon component
 * - overflowCount: Display formatted overflow count (e.g., +5, +1k)
 * - color: Semantic colors (primary, secondary, success, info, discovery, danger)
 * - variant: Visual variant (soft, solid)
 * - onClick/onPointerDown: Interactive state (renders as button)
 *
 * widget-ui enhancements (additional features):
 * - status: Display online, offline, away, busy, or dnd status indicator
 * - statusPlacement: Position of status indicator (top-right, top-left, bottom-right, bottom-left)
 * - statusAnimated: Animate status indicator with pulse effect (online status)
 * - verified: Show verification checkmark badge
 *
 * Custom rounding supported via className (e.g., className="rounded-lg")
 *
 * @example Basic usage
 * <Avatar name="John Doe" />
 * <Avatar imageUrl="https://example.com/avatar.jpg" name="John Doe" />
 *
 * @example Colors and variants
 * <Avatar color="primary" variant="solid" Icon={UserIcon} />
 *
 * @example Status indicators (widget-ui enhancement)
 * <Avatar name="Jane" status="online" statusAnimated />
 *
 * @example Verified badge (widget-ui enhancement)
 * <Avatar name="Taylor Swift" verified />
 *
 * @example Custom rounding (brand/company avatars)
 * <Avatar name="Acme, Co." className="rounded-lg" />
 */

import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../lib/utils";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Semantic color system (OpenAI feature)
 */
export type AvatarColor =
	| "primary"
	| "secondary"
	| "success"
	| "info"
	| "discovery"
	| "danger";

type ImageStatus = undefined | "error" | "loaded";

// ============================================================================
// VARIANTS
// ============================================================================

const avatarVariants = cva(
	[
		"relative inline-flex items-center justify-center overflow-hidden",
		"flex-shrink-0 flex-grow-0 select-none rounded-full",
		"transition-colors duration-300",
	],
	{
		variants: {
			variant: {
				soft: "",
				solid: "",
			},
			color: {
				primary: "",
				secondary: "",
				success: "",
				info: "",
				discovery: "",
				danger: "",
			},
		},
		compoundVariants: [
			// === SOFT VARIANT ===
			{
				variant: "soft",
				color: "primary",
				class: "bg-primary/10 text-primary",
			},
			{
				variant: "soft",
				color: "secondary",
				class: "bg-secondary text-secondary-foreground",
			},
			{
				variant: "soft",
				color: "success",
				class: "bg-success/10 text-success",
			},
			{
				variant: "soft",
				color: "info",
				class: "bg-info/10 text-info",
			},
			{
				variant: "soft",
				color: "discovery",
				class: "bg-discovery/10 text-discovery",
			},
			{
				variant: "soft",
				color: "danger",
				class: "bg-destructive/10 text-destructive",
			},

			// === SOLID VARIANT ===
			{
				variant: "solid",
				color: "primary",
				class: "bg-primary text-primary-foreground",
			},
			{
				variant: "solid",
				color: "secondary",
				class: "bg-muted-foreground text-background",
			},
			{
				variant: "solid",
				color: "success",
				class: "bg-success text-success-foreground",
			},
			{
				variant: "solid",
				color: "info",
				class: "bg-info text-info-foreground",
			},
			{
				variant: "solid",
				color: "discovery",
				class: "bg-discovery text-discovery-foreground",
			},
			{
				variant: "solid",
				color: "danger",
				class: "bg-destructive text-destructive-foreground",
			},
		],
		defaultVariants: {
			variant: "soft",
			color: "secondary",
		},
	},
);

// ============================================================================
// PROPS
// ============================================================================

/**
 * Status indicator type
 */
export type AvatarStatus = "online" | "offline" | "away" | "busy" | "dnd";

/**
 * Status badge placement
 */
export type AvatarStatusPlacement =
	| "top-right"
	| "top-left"
	| "bottom-right"
	| "bottom-left";

export interface AvatarProps
	extends
		Omit<
			React.ComponentProps<"span"> & React.ComponentProps<"button">,
			"color" | "type"
		>,
		Omit<VariantProps<typeof avatarVariants>, "color"> {
	/**
	 * Size of the avatar in pixels
	 * @default 32
	 */
	size?: number;
	/**
	 * Semantic color
	 * @default "secondary"
	 */
	color?: AvatarColor;
	/**
	 * Name used to display initials from
	 */
	name?: string;
	/**
	 * URL of the image to display as the avatar
	 */
	imageUrl?: string;
	/**
	 * Icon component to render in the avatar
	 */
	Icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
	/**
	 * Display a formatted count of overflow objects (e.g., for avatar groups)
	 */
	overflowCount?: number;
	/**
	 * Optional click handler (makes avatar interactive as button)
	 */
	onClick?: () => void;
	/**
	 * Optional pointer down handler (makes avatar interactive as button)
	 */
	onPointerDown?: () => void;
	/**
	 * Show status indicator
	 */
	status?: AvatarStatus | null;
	/**
	 * Position of status badge
	 * @default "bottom-right"
	 */
	statusPlacement?: AvatarStatusPlacement;
	/**
	 * Animate status indicator (pulse for online)
	 * @default false
	 */
	statusAnimated?: boolean;
	/**
	 * Show verification badge
	 * @default false
	 */
	verified?: boolean;
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

const AvatarImage = ({
	url,
	status,
	onLoad,
	onError,
}: {
	url: string;
	status: ImageStatus;
	onLoad: () => void;
	onError: () => void;
}) => {
	return (
		<span className="rounded-[inherit]">
			<img
				src={url}
				alt=""
				onLoad={onLoad}
				onError={onError}
				className={cn(
					"pointer-events-none absolute inset-0 h-full w-full rounded-[inherit] object-cover",
					"opacity-0 transition-opacity duration-150",
					status === "loaded" && "opacity-100",
				)}
			/>
			{/* Subtle border for low-contrast images */}
			<span className="pointer-events-none absolute inset-0 rounded-[inherit] border border-border-subtle" />
		</span>
	);
};

const AvatarInitial = ({
	name = "",
	size,
}: {
	name?: string;
	size: number;
}) => {
	const firstInitial = React.useMemo(
		() => name.charAt(0).toUpperCase(),
		[name],
	);
	const fontSize = size * 0.45; // OpenAI uses ~45% of avatar size

	return (
		<span className="font-semibold" style={{ fontSize }}>
			{firstInitial}
		</span>
	);
};

const AvatarOverflowCount = ({
	count,
	size,
}: {
	count: number;
	size: number;
}) => {
	const formattedCount = React.useMemo<string>(() => {
		return new Intl.NumberFormat("en", {
			notation: "compact",
			compactDisplay: "short",
			maximumFractionDigits: 0,
		})
			.format(count)
			.toLocaleLowerCase();
	}, [count]);

	// Scale font size based on character count
	const letterCount = formattedCount.length;
	const fontScaling = letterCount === 1 ? 0.5 : letterCount === 2 ? 0.4 : 0.35;
	const fontSize = size * fontScaling;

	return (
		<span className="font-semibold" style={{ fontSize }}>
			<span className="relative -top-px -ml-px">+</span>
			{formattedCount}
		</span>
	);
};

const AvatarIcon = ({
	Icon,
	size,
}: {
	Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
	size: number;
}) => {
	const iconSize = size * 0.7;

	return (
		<Icon
			className="block flex-shrink-0 flex-grow-0"
			style={{ width: iconSize, height: iconSize }}
		/>
	);
};

const AvatarStatusIndicator = ({
	status,
	size,
	placement = "bottom-right",
	animated = false,
}: {
	status: AvatarStatus;
	size: number;
	placement?: AvatarStatusPlacement;
	animated?: boolean;
}) => {
	const statusSize = Math.max(8, size * 0.25);

	const statusColors = {
		online: "bg-success",
		offline: "bg-muted-foreground",
		away: "bg-caution",
		busy: "bg-destructive",
		dnd: "bg-destructive",
	};

	const placementClasses = {
		"top-right": "top-0 right-0",
		"top-left": "top-0 left-0",
		"bottom-right": "bottom-0 right-0",
		"bottom-left": "bottom-0 left-0",
	};

	return (
		<span
			className={cn(
				"absolute rounded-full border-2 border-background",
				placementClasses[placement],
				statusColors[status],
				animated && status === "online" && "animate-pulse",
			)}
			style={{
				width: statusSize,
				height: statusSize,
			}}
			aria-label={`Status: ${status}`}
		/>
	);
};

const AvatarVerifiedBadge = ({ size }: { size: number }) => {
	const badgeSize = Math.max(12, size * 0.3);

	return (
		<span
			className="absolute right-0 bottom-0 flex items-center justify-center rounded-full bg-info text-info-foreground ring-2 ring-background"
			style={{
				width: badgeSize,
				height: badgeSize,
			}}
			aria-label="Verified"
		>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{
					width: badgeSize * 0.6,
					height: badgeSize * 0.6,
				}}
			>
				<polyline points="20 6 9 17 4 12" />
			</svg>
		</span>
	);
};

// ============================================================================
// UTILITIES
// ============================================================================

const validateImageUrl = (imageUrl?: string): string | undefined => {
	if (!imageUrl) return undefined;

	// Avoid specific gravatar pattern that uses pair initials
	if (imageUrl.includes("gravatar.com") && imageUrl.includes("cdn.auth0.com")) {
		return undefined;
	}

	return imageUrl;
};

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Avatar - shadcn/ui Avatar with OpenAI apps-sdk-ui features
 *
 * @example Basic with name (shows initials)
 * ```tsx
 * <Avatar name="John Doe" />
 * ```
 *
 * @example With image
 * ```tsx
 * <Avatar imageUrl="https://example.com/avatar.jpg" name="John Doe" />
 * ```
 *
 * @example With custom size and color
 * ```tsx
 * <Avatar size={48} color="primary" variant="solid" name="Jane" />
 * ```
 *
 * @example With icon
 * ```tsx
 * <Avatar Icon={UserIcon} color="info" />
 * ```
 *
 * @example Interactive (as button)
 * ```tsx
 * <Avatar name="JD" onClick={() => console.log('clicked')} />
 * ```
 *
 * @example Overflow count (for groups)
 * ```tsx
 * <Avatar overflowCount={5} color="secondary" />
 * ```
 *
 * @example With status indicator
 * ```tsx
 * <Avatar name="John Doe" status="online" statusAnimated />
 * ```
 *
 * @example With verification badge
 * ```tsx
 * <Avatar name="Jane Smith" verified />
 * ```
 */
export function Avatar({
	className,
	variant = "soft",
	color = "secondary",
	size = 32,
	name,
	imageUrl: imageUrlProp,
	Icon,
	overflowCount,
	onClick,
	onPointerDown,
	status,
	statusPlacement = "bottom-right",
	statusAnimated = false,
	verified = false,
	style,
	...props
}: AvatarProps) {
	const validImageUrl = validateImageUrl(imageUrlProp);
	const [imageStatus, setImageStatus] = React.useState<ImageStatus>();
	const isInteractive = !!(onClick || onPointerDown);

	// Reset image status when URL changes
	React.useEffect(() => {
		setImageStatus(undefined);
	}, [validImageUrl]);

	// Render as button if interactive
	const Comp = isInteractive ? "button" : "span";

	const content = (() => {
		if (validImageUrl && imageStatus !== "error") {
			return (
				<AvatarImage
					url={validImageUrl}
					status={imageStatus}
					onLoad={() => setImageStatus("loaded")}
					onError={() => setImageStatus("error")}
				/>
			);
		}
		if (Icon) {
			return <AvatarIcon Icon={Icon} size={size} />;
		}
		if (overflowCount) {
			return <AvatarOverflowCount count={overflowCount} size={size} />;
		}
		return <AvatarInitial name={name} size={size} />;
	})();

	return (
		<Comp
			role={isInteractive ? undefined : "presentation"}
			type={isInteractive ? "button" : undefined}
			data-slot="avatar"
			data-variant={variant}
			data-color={color}
			onClick={onClick}
			onPointerDown={onPointerDown}
			className={cn(
				avatarVariants({ variant, color }),
				isInteractive && [
					"cursor-pointer",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
				],
				className,
			)}
			style={{
				width: size,
				height: size,
				...style,
			}}
			{...props}
		>
			{content}
			{status && (
				<AvatarStatusIndicator
					status={status}
					size={size}
					placement={statusPlacement}
					animated={statusAnimated}
				/>
			)}
			{verified && !status && <AvatarVerifiedBadge size={size} />}
		</Comp>
	);
}

// Export variants for external use
export { avatarVariants };
