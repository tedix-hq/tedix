import { emptyVariants } from "@cloudflare/kumo/components/empty";
import {
	type ComponentProps,
	type ReactNode,
	createContext,
	useContext,
} from "react";
import { cn } from "../../lib/utils";

type EmptyAppearance = "default" | "quiet" | "inline";

/**
 * `docs/engineering/product/design.md` reserves the `dialog` tier for PROMINENT empty-state
 * titles. `quiet` and `inline` are the bounded-collection appearances — an
 * absent list inside a card, or a panel that already owns its heading — so an
 * 18px title there outranks the surface containing it.
 *
 * Seventeen call sites had already reached that conclusion and tried to fix it
 * locally with `className="text-sm"` on the title and `text-xs` on the
 * description. Every one was inert: the `.type-tedix-*` roles are `!important`,
 * and `tailwind-merge` does not recognise them as a font-size group, so both
 * classes reached the DOM and the role always won. The tier belongs to the
 * appearance, not to each caller.
 */
const AppearanceContext = createContext<EmptyAppearance>("default");

const TITLE_TIER: Record<EmptyAppearance, string> = {
	default: "type-tedix-dialog",
	quiet: "type-tedix-body",
	inline: "type-tedix-body",
};

const DESCRIPTION_TIER: Record<EmptyAppearance, string> = {
	default: "type-tedix-body",
	quiet: "type-tedix-label",
	inline: "type-tedix-label",
};

interface EmptyProps extends Omit<ComponentProps<"div">, "title"> {
	appearance?: EmptyAppearance;
	contents?: ReactNode;
	description?: string;
	icon?: ReactNode;
	title?: string;
}

const APPEARANCE_CLASSES = {
	default: "",
	quiet:
		"rounded-lg! border-kumo-hairline! border-dashed! bg-transparent! px-4! py-10! sm:px-8!",
	inline: "rounded-none! border-0! bg-transparent! px-0! py-10!",
} as const;

/**
 * Kumo's Empty is prop-driven; this adapter retains Tedix's compositional API
 * while using Kumo's surface, spacing, and semantic tokens.
 */
function Empty({
	appearance = "default",
	children,
	className,
	contents,
	description,
	icon,
	title,
	...props
}: EmptyProps) {
	const body =
		title !== undefined ? (
			<div
				data-slot="empty"
				data-appearance={appearance}
				className={cn(
					emptyVariants({ size: "base" }),
					APPEARANCE_CLASSES[appearance],
					className,
				)}
				{...props}
			>
				{icon}
				<h2
					data-slot="empty-title"
					className={cn("font-semibold", TITLE_TIER[appearance])}
				>
					{title}
				</h2>
				{description && (
					<p
						data-slot="empty-description"
						className={cn(
							"max-w-140 text-center text-kumo-subtle",
							DESCRIPTION_TIER[appearance],
						)}
					>
						{description}
					</p>
				)}
				{contents ?? children}
			</div>
		) : (
			<div
				data-slot="empty"
				data-appearance={appearance}
				className={cn(
					emptyVariants({ size: "base" }),
					"min-w-0 flex-1 justify-center text-balance text-center",
					APPEARANCE_CLASSES[appearance],
					className,
				)}
				{...props}
			>
				{children}
			</div>
		);

	return (
		<AppearanceContext.Provider value={appearance}>
			{body}
		</AppearanceContext.Provider>
	);
}

function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-header"
			className={cn("flex max-w-sm flex-col items-center gap-2", className)}
			{...props}
		/>
	);
}

function EmptyMedia({
	className,
	variant = "default",
	...props
}: ComponentProps<"div"> & { variant?: "default" | "icon" }) {
	return (
		<div
			data-slot="empty-icon"
			data-variant={variant}
			className={cn(
				"mb-2 flex shrink-0 items-center justify-center",
				variant === "icon" &&
					"size-10 rounded-lg bg-kumo-fill text-kumo-default [&_svg:not([class*='size-'])]:size-6",
				className,
			)}
			{...props}
		/>
	);
}

function EmptyTitle({ className, ...props }: ComponentProps<"h2">) {
	const appearance = useContext(AppearanceContext);
	return (
		<h2
			data-slot="empty-title"
			className={cn(
				"font-medium text-kumo-strong",
				TITLE_TIER[appearance],
				className,
			)}
			{...props}
		/>
	);
}

function EmptyDescription({ className, ...props }: ComponentProps<"div">) {
	const appearance = useContext(AppearanceContext);
	return (
		<div
			data-slot="empty-description"
			className={cn(
				"text-kumo-subtle [&>a:hover]:text-kumo-link [&>a]:underline [&>a]:underline-offset-4",
				DESCRIPTION_TIER[appearance],
				className,
			)}
			{...props}
		/>
	);
}

function EmptyContent({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="empty-content"
			className={cn(
				"flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance type-tedix-body",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
};
