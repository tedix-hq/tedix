import type { ReactNode } from "react";
import { Input } from "@/components/kumo/input";
import { Toolbar } from "@/components/kumo/toolbar";

/**
 * The one editor toolbar grammar. Document and Sheet each hand-rolled this row
 * and drifted apart inside a single release: one grew hairline groups and
 * icon-sized colour targets while the other kept fifteen undifferentiated icons
 * and two text-labelled swatches. A third output surface must not get to
 * re-decide what a toolbar is, so the row chrome, the icon target, the group
 * hairline, and the colour target all live here.
 *
 * `docs/engineering/product/design.md` owns the rule these primitives encode: one
 * horizontally scrollable row, controls separated into scannable groups by
 * a hairline, and every control either a labelled Select or a square icon
 * target -- colour pickers included.
 */

/**
 * The scrolling row itself. `.output-editor-toolbar` in `styles.css` owns its
 * height, padding, and scroll behaviour; the sizing rule inside it is scoped to
 * `button[data-toolbar-control="icon"]` so a Kumo `SelectTrigger` (which also
 * renders as a direct `button` child) keeps its label instead of being crushed
 * to a 28px caret.
 */
export function EditorToolbar({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={`output-editor-toolbar overflow-x-auto border-kumo-line border-y bg-kumo-base${
				className ? ` ${className}` : ""
			}`}
		>
			<Toolbar
				size="sm"
				className="min-w-max rounded-none bg-kumo-base shadow-none ring-0"
			>
				{children}
			</Toolbar>
		</div>
	);
}

/** Square icon target. `data-toolbar-control="icon"` is what `styles.css` sizes. */
export function EditorToolbarButton({
	label,
	active,
	disabled,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Toolbar.Button
			type="button"
			shape="square"
			data-toolbar-control="icon"
			aria-label={label}
			title={label}
			aria-pressed={active}
			className={active ? "bg-kumo-tint" : undefined}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
		</Toolbar.Button>
	);
}

/**
 * Hairline between toolbar groups. Fifteen to twenty undifferentiated icons
 * read as noise; the groups are what a reader actually scans for.
 */
export function EditorToolbarDivider() {
	return <span className="mx-2 h-5 w-px shrink-0 bg-kumo-line" aria-hidden />;
}

/**
 * Colour control shaped like every other toolbar target: a glyph over a bar
 * showing the current value, with the native picker overlaid transparently. A
 * text-labelled swatch ("Text [swatch]") is the widest, loudest item in a row
 * of 28px icons.
 *
 * `swatchRingClassName` exists because these are artifact colours chosen
 * against the artifact, not against the shell: ringing the bar in the surface's
 * own paper token keeps a near-black ink visible on a toolbar of any polarity.
 */
export function EditorToolbarColorButton({
	label,
	color,
	disabled,
	onChange,
	swatchRingClassName = "ring-kumo-line",
	children,
}: {
	label: string;
	color: string;
	disabled?: boolean;
	onChange: (color: string) => void;
	swatchRingClassName?: string;
	children: ReactNode;
}) {
	return (
		<label
			title={label}
			data-toolbar-control="color"
			className="relative inline-flex size-7 shrink-0 cursor-pointer flex-col items-center justify-center gap-px rounded-md text-kumo-default transition-colors hover:bg-kumo-interact has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 motion-reduce:transition-none"
		>
			{children}
			<span
				aria-hidden
				className={`h-[4px] w-4 rounded-full ring-1 ${swatchRingClassName}`}
				style={{ background: color }}
			/>
			<Input
				type="color"
				aria-label={label}
				className="absolute inset-0 size-full cursor-pointer rounded-md border-0 bg-transparent p-0 opacity-0 shadow-none"
				disabled={disabled}
				value={color}
				onChange={(event) => onChange(event.target.value)}
			/>
		</label>
	);
}
