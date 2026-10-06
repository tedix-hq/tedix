import {
	Button as KumoButton,
	buttonVariants as kumoButtonVariants,
} from "@cloudflare/kumo/components/button";
import { Loader } from "@cloudflare/kumo/components/loader";
import { Button as ButtonPrimitive } from "@cloudflare/kumo/primitives/button";
import {
	type ButtonHTMLAttributes,
	type CSSProperties,
	cloneElement,
	forwardRef,
	type ReactElement,
	type ReactNode,
	type Ref,
} from "react";
import { cn } from "../../lib/utils";

type ButtonVariant =
	| "default"
	| "outline"
	| "secondary"
	| "ghost"
	| "destructive"
	| "link";

type TextButtonSize = "default" | "xs" | "sm" | "lg";
type IconButtonSize = "icon" | "icon-xs" | "icon-sm" | "icon-lg";
type ButtonSize = TextButtonSize | IconButtonSize;

const VARIANT_MAP = {
	default: "primary",
	outline: "outline",
	secondary: "secondary",
	ghost: "ghost",
	destructive: "destructive",
	link: "ghost",
} as const;

const SIZE_MAP = {
	default: "base",
	xs: "xs",
	sm: "sm",
	lg: "lg",
	icon: "base",
	"icon-xs": "xs",
	"icon-sm": "sm",
	"icon-lg": "lg",
} as const;

/*
 * Kumo supplies its size classes from the package build, but a product shell's
 * button reset can resolve after those utilities. Without an
 * explicit adapter-owned role, compact text buttons inherit the document size
 * even though their markup still says `text-xs`. Keep geometry with Kumo and
 * make typography a Tedix semantic contract.
 */
const TEXT_SIZE_CLASS: Record<TextButtonSize, string> = {
	default: "type-tedix-body !font-medium",
	xs: "type-tedix-caption !font-medium",
	sm: "type-tedix-control !font-medium",
	lg: "type-tedix-body !font-medium",
};

function textSizeClass(size: ButtonSize) {
	return isIconSize(size) ? undefined : TEXT_SIZE_CLASS[size as TextButtonSize];
}

/*
 * Product density is a semantic contract, not an accident of Kumo's internal
 * size aliases. Compact text controls use the 28px Console rhythm while their
 * adjacent icon actions retain a 32px hit area. Base and large sizes already
 * resolve to the shared 36px and 40px tiers upstream.
 */
const PRODUCT_SIZE_CLASS: Partial<Record<ButtonSize, string>> = {
	xs: "!h-6",
	sm: "!h-7",
	"icon-xs": "!size-6",
	"icon-sm": "!size-8",
};

/*
 * Console sizes controls below the comfortable touch target for a finger, so
 * Tedix keeps a 44px floor on narrow product layouts and wherever the pointer
 * is coarse. The viewport rule makes the documented 390px contract predictable
 * even when browser device emulation reports a fine pointer; the capability
 * rule still covers tablets and touch laptops above `sm`. Radius stays with
 * Kumo's size variant (`xs` rounded-sm, `sm` rounded-md, `base`/`lg` rounded-lg)
 * — forcing `rounded-lg` on every size breaks concentric radii on compact controls.
 */
const COARSE_TOUCH_TARGET =
	"max-sm:min-h-11 max-sm:min-w-11 coarse:min-h-11 coarse:min-w-11 motion-reduce:transition-none";

/*
 * Every Kumo text size is a FIXED height (`xs` h-5, `sm` h-6.5, `base` h-9,
 * `lg` h-10) sized for one line, so a button whose child stacks two lines — a
 * name over a subtitle in a picker row — overflows its own box and paints over
 * whatever follows it. `multiline` hands the height back to the content and
 * pins the 44px floor for every pointer, not just coarse ones: a two-line row
 * needs the room regardless of input device. Single-line buttons never opt in,
 * so their metrics stay exactly Kumo's.
 */
const MULTILINE_HEIGHT = "h-auto min-h-11";

function isIconSize(size: ButtonSize) {
	return size.startsWith("icon");
}

/*
 * Kumo's emphasis buttons are glossy; Tedix action fills are flat. Kumo paints
 * that gloss from four custom properties and nothing else, so the flattening
 * belongs here rather than in a CSS rule that reaches into its render tree:
 *
 *   root span  background: bg-(--kumo-button-emphasis-bg)
 *   overlay    background: linear-gradient(to bottom, -gradient-start, -gradient-end)
 *              box-shadow: inset 0 1px 0 0 var(--kumo-button-emphasis-bg)
 *              hover:     gradient-start := var(--kumo-button-emphasis-bg)
 *   ring       ring-(--kumo-button-emphasis-ring)
 *
 * Setting start === end flattens the gradient; setting `-bg` to the same value
 * makes the derived inset highlight invisible instead of reintroducing a sheen
 * one pixel tall, and keeps the hover swap flat too. Only the ring keeps its
 * darker mix, which is the button's edge rather than its fill. Kumo merges
 * `style: {...emphasisStyle, ...style}`, so a caller can still override any of
 * these per instance.
 */
function tedixEmphasisStyle(
	variant: ButtonVariant,
	style?: CSSProperties,
): CSSProperties | undefined {
	const token =
		variant === "default"
			? "var(--tedix-action-primary)"
			: variant === "destructive"
				? "var(--tedix-action-danger)"
				: null;
	if (!token) return style;
	return {
		// Kumo's emphasis variant resolves its forced `!text-white` through this
		// palette token. Default actions pair the tenant accent with the theme
		// compiler's validated foreground; destructive actions retain true white.
		...(variant === "default"
			? { "--color-white": "var(--primary-foreground)" }
			: {}),
		"--kumo-button-emphasis-ring": `color-mix(in oklch, ${token}, black 10%)`,
		"--kumo-button-emphasis-bg": token,
		"--kumo-button-emphasis-gradient-start": token,
		"--kumo-button-emphasis-gradient-end": token,
		...style,
	} as CSSProperties;
}

interface ButtonVariantsProps {
	className?: string;
	multiline?: boolean;
	size?: ButtonSize;
	variant?: ButtonVariant;
}

function buttonVariants({
	className,
	multiline,
	size = "default",
	variant = "default",
}: ButtonVariantsProps = {}) {
	const iconSize = isIconSize(size);
	return cn(
		kumoButtonVariants({
			shape: iconSize ? "square" : "base",
			size: SIZE_MAP[size],
			variant: VARIANT_MAP[variant],
		}),
		COARSE_TOUCH_TARGET,
		(!multiline || iconSize) && PRODUCT_SIZE_CLASS[size],
		textSizeClass(size),
		variant === "link" &&
			"bg-transparent text-kumo-link underline-offset-4 shadow-none hover:underline",
		multiline && !iconSize && MULTILINE_HEIGHT,
		className,
	);
}

type RenderElement = ReactElement<{
	children?: ReactNode;
	className?: string;
	"data-kumo-component"?: string;
	"data-slot"?: string;
	style?: CSSProperties;
	title?: string;
	href?: unknown;
	to?: unknown;
}>;

interface ButtonBaseProps extends Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	"title"
> {
	icon?: ReactNode;
	loading?: boolean;
	nativeButton?: boolean;
	render?: RenderElement;
	title?: ReactNode;
	variant?: ButtonVariant;
}

type IconButtonAccessibleName =
	| { "aria-label": string; "aria-labelledby"?: string }
	| { "aria-label"?: string; "aria-labelledby": string }
	| {
			"aria-label"?: string;
			"aria-labelledby"?: string;
			title: string | number;
	  };

/*
 * `multiline` is only meaningful for text sizes: icon sizes are square
 * (`size-*` on both axes), so releasing their height would just deform them.
 */
type ButtonProps =
	| (ButtonBaseProps & { multiline?: boolean; size?: TextButtonSize })
	| (ButtonBaseProps &
			IconButtonAccessibleName & { multiline?: never; size: IconButtonSize });

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{
		children,
		className,
		icon,
		loading,
		multiline,
		nativeButton: _nativeButton,
		render,
		size = "default",
		style,
		title,
		variant = "default",
		...props
	},
	ref,
) {
	if (render) {
		const disabled = loading || props.disabled;
		const renderElement = disabled
			? cloneElement(render, { href: undefined, to: undefined })
			: render;

		return (
			<ButtonPrimitive
				{...props}
				ref={ref as Ref<HTMLElement>}
				render={renderElement}
				nativeButton={_nativeButton ?? render.type === "button"}
				disabled={disabled}
				aria-disabled={disabled || undefined}
				aria-busy={loading || undefined}
				className={buttonVariants({
					className: cn(render.props.className, className),
					multiline,
					size,
					variant,
				})}
				data-icon-only={isIconSize(size) || undefined}
				data-kumo-component="LinkButton"
				data-slot="button"
				style={tedixEmphasisStyle(variant, style)}
				title={typeof title === "string" ? title : undefined}
			>
				{loading && <Loader aria-label="Loading" size={14} />}
				{children ?? render.props.children}
			</ButtonPrimitive>
		);
	}

	const shape = isIconSize(size) ? "square" : "base";
	const accessibleName =
		props["aria-label"] ??
		(typeof title === "string" ? title : undefined) ??
		(shape === "square" && typeof children === "string" ? children : undefined);
	const tooltipTitle =
		typeof title === "string" || typeof title === "number"
			? String(title)
			: undefined;
	if (
		import.meta.env.DEV &&
		shape === "square" &&
		!accessibleName &&
		!props["aria-labelledby"]
	) {
		console.warn(
			"[Tedix Kumo Button]: icon buttons need an aria-label, aria-labelledby, or string title.",
		);
	}

	if (shape === "square") {
		return (
			<KumoButton
				{...props}
				ref={ref}
				aria-label={accessibleName as string}
				className={cn(COARSE_TOUCH_TARGET, PRODUCT_SIZE_CLASS[size], className)}
				data-icon-only="true"
				data-slot="button"
				icon={icon}
				loading={loading}
				shape="square"
				size={SIZE_MAP[size]}
				style={tedixEmphasisStyle(variant, style)}
				title={tooltipTitle}
				variant={VARIANT_MAP[variant]}
			>
				{children}
			</KumoButton>
		);
	}

	return (
		<KumoButton
			{...props}
			ref={ref}
			aria-label={accessibleName}
			className={cn(
				COARSE_TOUCH_TARGET,
				!multiline && PRODUCT_SIZE_CLASS[size],
				textSizeClass(size),
				multiline && MULTILINE_HEIGHT,
				className,
			)}
			data-slot="button"
			icon={icon}
			loading={loading}
			shape="base"
			size={SIZE_MAP[size]}
			style={tedixEmphasisStyle(variant, style)}
			title={tooltipTitle}
			variant={VARIANT_MAP[variant]}
		>
			{children}
		</KumoButton>
	);
});

export { Button, type ButtonProps, buttonVariants };
