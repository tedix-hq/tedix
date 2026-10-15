import {
	ArrowRight,
	Cards,
	Circle,
	FileSvg,
	ImageSquare,
	ListBullets,
	Minus,
	Plus,
	Square,
	Tag,
	TextAlignLeft,
	TextH,
	TextT,
	UploadSimple,
	type Icon,
} from "@phosphor-icons/react";
import type { OsPresentationElementType } from "@tedix/api-contract/schemas/os-workspaces";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import {
	PopoverContent,
	PopoverRoot,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { SLIDE_IMAGE_TYPES } from "@/lib/slide-image-upload";

export interface SlideComponent {
	type: OsPresentationElementType;
	name: string;
	description: string;
	icon: Icon;
}

/** Every presentation element type, grouped the way the library lists them. */
export const SLIDE_COMPONENT_CATEGORIES: readonly {
	name: "Text" | "Containers" | "Decoration" | "Visual";
	components: readonly SlideComponent[];
}[] = [
	{
		name: "Text",
		components: [
			{
				type: "title",
				name: "Title",
				description: "Display headline",
				icon: TextH,
			},
			{
				type: "subtitle",
				name: "Subtitle",
				description: "Supporting line under a title",
				icon: TextT,
			},
			{
				type: "text",
				name: "Text",
				description: "Free-form paragraph",
				icon: TextAlignLeft,
			},
			{
				type: "bullet",
				name: "Bullet list",
				description: "One point per line",
				icon: ListBullets,
			},
			{
				type: "label",
				name: "Label",
				description: "Small section eyebrow",
				icon: Tag,
			},
		],
	},
	{
		name: "Containers",
		components: [
			{
				type: "card",
				name: "Card",
				description: "Bordered panel with text",
				icon: Cards,
			},
			{
				type: "box",
				name: "Box",
				description: "Filled diagram block",
				icon: Square,
			},
		],
	},
	{
		name: "Decoration",
		components: [
			{
				type: "divider",
				name: "Divider",
				description: "Horizontal rule",
				icon: Minus,
			},
			{
				type: "shape",
				name: "Shape",
				description: "Filled circle or rectangle",
				icon: Circle,
			},
			{
				type: "arrow",
				name: "Arrow",
				description: "Connector between blocks",
				icon: ArrowRight,
			},
		],
	},
	{
		name: "Visual",
		components: [
			{
				type: "image",
				name: "Image",
				description: "Picture from a URL",
				icon: ImageSquare,
			},
			{
				type: "svg",
				name: "SVG",
				description: "Vector graphic from a URL",
				icon: FileSvg,
			},
		],
	},
];

const ALL_COMPONENTS = SLIDE_COMPONENT_CATEGORIES.flatMap(
	(category) => category.components,
);

/** Library rows whose name, description or type contain the query. */
export function filterSlideComponents(query: string): SlideComponent[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return ALL_COMPONENTS;
	return ALL_COMPONENTS.filter((component) =>
		[component.name, component.description, component.type].some((field) =>
			field.toLocaleLowerCase().includes(needle),
		),
	);
}

/** A button that picks one image file from the device. */
export function SlideImageUploadButton({
	label,
	disabled,
	onFile,
}: {
	label: string;
	disabled?: boolean;
	onFile: (file: File) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				disabled={disabled}
				onClick={() => input.current?.click()}
			>
				<UploadSimple size={14} /> {label}
			</Button>
			<SlideImageFileInput
				ref={input}
				label={label}
				disabled={disabled}
				onFile={onFile}
			/>
		</>
	);
}

function SlideImageFileInput({
	ref,
	label,
	disabled,
	onFile,
}: {
	ref: React.Ref<HTMLInputElement>;
	label: string;
	disabled?: boolean;
	onFile: (file: File) => void;
}) {
	return (
		<Input
			ref={ref}
			type="file"
			aria-label={label}
			disabled={disabled}
			accept={SLIDE_IMAGE_TYPES.join(",")}
			className="sr-only"
			tabIndex={-1}
			onChange={(event) => {
				const file = event.target.files?.[0];
				if (file) onFile(file);
				event.target.value = "";
			}}
		/>
	);
}

function ComponentRow({
	component,
	onInsert,
}: {
	component: SlideComponent;
	onInsert: (type: OsPresentationElementType) => void;
}) {
	const RowIcon = component.icon;
	return (
		<li>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				multiline
				className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
				data-slide-component={component.type}
				aria-label={`Insert ${component.name}: ${component.description}`}
				onClick={() => onInsert(component.type)}
			>
				<RowIcon size={16} aria-hidden className="shrink-0" />
				<span className="grid min-w-0">
					<span className="truncate font-medium">{component.name}</span>
					<span className="truncate text-kumo-subtle text-xs">
						{component.description}
					</span>
				</span>
			</Button>
		</li>
	);
}

/**
 * The slide component library: a filterable list of every element type behind
 * the toolbar's Insert control. Typing filters by name and description; Enter
 * inserts the first match; Escape clears the query before it closes the list.
 */
export function SlideInsertLibrary({
	disabled,
	onInsert,
	onUploadImage,
}: {
	disabled?: boolean;
	onInsert: (type: OsPresentationElementType) => void;
	onUploadImage: (file: File) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const filterInput = useRef<HTMLInputElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const listId = useId();
	const matches = filterSlideComponents(query);
	const insert = (type: OsPresentationElementType) => {
		setOpen(false);
		setQuery("");
		onInsert(type);
	};
	const rows = (components: readonly SlideComponent[]) => (
		<ul className="m-0 grid list-none gap-0.5 p-0">
			{components.map((component) => (
				<ComponentRow
					key={component.type}
					component={component}
					onInsert={insert}
				/>
			))}
		</ul>
	);
	return (
		<>
			<PopoverRoot
				open={open}
				onOpenChange={(next, details) => {
					if (!next && details.reason === "escape-key" && query) {
						details.cancel();
						setQuery("");
						return;
					}
					setOpen(next);
					if (!next) setQuery("");
				}}
			>
				<PopoverTrigger
					render={
						<Button
							size="sm"
							variant="ghost"
							disabled={disabled}
							aria-label="Insert slide element"
						/>
					}
				>
					<Plus size={14} /> Insert…
				</PopoverTrigger>
				<PopoverContent
					align="start"
					aria-label="Component library"
					className="w-[min(20rem,calc(100vw-2rem))] gap-2 p-2"
					initialFocus={filterInput}
				>
					<Input
						ref={filterInput}
						size="sm"
						aria-label="Filter components"
						aria-controls={listId}
						placeholder="Filter components"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								const first = matches[0];
								if (first) insert(first.type);
							}
						}}
					/>
					<div id={listId} className="grid max-h-80 gap-2 overflow-y-auto">
						{matches.length === 0 ? (
							<Text role="label" tone="secondary" className="m-0 p-2">
								No matching components
							</Text>
						) : query.trim() ? (
							rows(matches)
						) : (
							SLIDE_COMPONENT_CATEGORIES.map((category) => (
								<section
									key={category.name}
									aria-label={category.name}
									className="grid gap-0.5"
								>
									<Text
										as="h3"
										role="label"
										tone="secondary"
										className="m-0 px-2 pt-1 font-semibold text-[11px] uppercase tracking-wide"
									>
										{category.name}
									</Text>
									{rows(category.components)}
								</section>
							))
						)}
					</div>
					<Button
						type="button"
						size="sm"
						variant="secondary"
						onClick={() => {
							setOpen(false);
							setQuery("");
							fileInput.current?.click();
						}}
					>
						<UploadSimple size={14} /> Upload image
					</Button>
				</PopoverContent>
			</PopoverRoot>
			<SlideImageFileInput
				ref={fileInput}
				label="Upload slide image"
				disabled={disabled}
				onFile={onUploadImage}
			/>
		</>
	);
}
