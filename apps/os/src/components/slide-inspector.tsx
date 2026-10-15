import {
	ArrowDown,
	ArrowUp,
	CaretRight,
	Copy,
	Trash,
} from "@phosphor-icons/react";
import type {
	OsPresentationCanvasSlide,
	OsPresentationElement,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Switch } from "@/components/kumo/switch";
import { SlideBackgroundControls } from "@/components/slide-background-controls";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import type { SlideElementAction } from "@/components/slide-element-actions";
import { SlideImageUploadButton } from "@/components/slide-insert-library";
import {
	SLIDE_FONT_FAMILIES,
	slideFieldValue,
	type SlideInspectorField,
	slideInspectorFields,
	writeSlideField,
} from "@/components/slide-inspector-fields";
import { safeImageSource } from "@/lib/output-models";
import {
	svgMarkupFromSource,
	svgSourceFromMarkup,
} from "@/lib/slide-svg-markup";

const MAX_NOTES_LENGTH = 10_000;
const DEFAULT_FONT = "__default";

function fieldLabel(field: SlideInspectorField) {
	return `Element ${field.label.toLowerCase()}`;
}

/** A number that commits while it is valid and settles to its bounds on blur. */
function NumberField({
	field,
	element,
	disabled,
	onChange,
}: {
	field: Extract<SlideInspectorField, { kind: "number" | "prop-number" }>;
	element: OsPresentationElement;
	disabled?: boolean;
	onChange: (next: OsPresentationElement) => void;
}) {
	const stored = slideFieldValue(element, field);
	const [draft, setDraft] = useState<string | null>(null);
	const value =
		draft ??
		(typeof stored === "number"
			? String(Math.round(stored * 1000) / 1000)
			: "");
	const inRange = (raw: string) => {
		const number = Number(raw);
		return (
			raw !== "" &&
			Number.isFinite(number) &&
			(field.min === undefined || number >= field.min) &&
			(field.max === undefined || number <= field.max)
		);
	};
	return (
		<Text as="label" role="label" tone="secondary" className="grid gap-1">
			{field.label}
			<Input
				type="number"
				aria-label={fieldLabel(field)}
				min={field.min}
				max={field.max}
				step={field.step}
				placeholder={
					field.placeholder === undefined
						? undefined
						: String(field.placeholder)
				}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					const raw = event.target.value;
					setDraft(raw);
					if (inRange(raw) || raw === "")
						onChange(writeSlideField(element, field, raw));
				}}
				onBlur={() => {
					if (draft !== null && !inRange(draft) && draft !== "")
						onChange(writeSlideField(element, field, draft));
					setDraft(null);
				}}
			/>
		</Text>
	);
}

/**
 * Element text kept as a draft while focused, so a parsed field such as the
 * comma-separated highlight words does not rewrite what is being typed.
 */
function TextPropField({
	field,
	element,
	disabled,
	onChange,
}: {
	field: Extract<
		SlideInspectorField,
		{ kind: "prop-text" | "highlight" | "items" }
	>;
	element: OsPresentationElement;
	disabled?: boolean;
	onChange: (next: OsPresentationElement) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const multiline =
		field.kind === "items" || (field.kind === "prop-text" && field.multiline);
	const Control = multiline ? Textarea : Input;
	return (
		<Text as="label" role="label" tone="secondary" className="grid gap-1">
			{field.label}
			<Control
				aria-label={fieldLabel(field)}
				disabled={disabled}
				placeholder={
					field.kind === "highlight"
						? "word, another phrase"
						: field.kind === "items"
							? "One item per line"
							: undefined
				}
				value={draft ?? String(slideFieldValue(element, field) ?? "")}
				onChange={(
					event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
				) => {
					setDraft(event.target.value);
					onChange(writeSlideField(element, field, event.target.value));
				}}
				onBlur={() => setDraft(null)}
			/>
		</Text>
	);
}

function SvgField({
	element,
	disabled,
	onChange,
}: {
	element: OsPresentationElement;
	disabled?: boolean;
	onChange: (next: OsPresentationElement) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const uploaded = element.src && !svgMarkupFromSource(element.src);
	return (
		<Text as="label" role="label" tone="secondary" className="grid gap-1">
			SVG code
			<Textarea
				aria-label="Element SVG code"
				className="slide-inspector-code"
				spellCheck={false}
				rows={6}
				disabled={disabled}
				placeholder={
					uploaded
						? "Linked image. Paste SVG code to replace it."
						: '<svg viewBox="0 0 100 100">…</svg>'
				}
				value={draft ?? svgMarkupFromSource(element.src)}
				onChange={(event) => {
					const markup = event.target.value;
					setDraft(markup);
					const result = svgSourceFromMarkup(markup);
					if (!result.ok) {
						setError(result.error);
						return;
					}
					setError(null);
					if (result.src !== undefined || !uploaded)
						onChange({ ...element, src: result.src });
				}}
				onBlur={() => setDraft(null)}
			/>
			{error && (
				<span role="alert" className="text-kumo-danger text-xs">
					{error}
				</span>
			)}
		</Text>
	);
}

function InspectorField({
	field,
	element,
	disabled,
	onChange,
}: {
	field: SlideInspectorField;
	element: OsPresentationElement;
	disabled?: boolean;
	onChange: (next: OsPresentationElement) => void;
}) {
	const [urlDraft, setUrlDraft] = useState<string | null>(null);
	switch (field.kind) {
		case "number":
		case "prop-number":
			return (
				<NumberField
					field={field}
					element={element}
					disabled={disabled}
					onChange={onChange}
				/>
			);
		case "svg":
			return (
				<SvgField element={element} disabled={disabled} onChange={onChange} />
			);
		case "prop-toggle":
			return (
				<Text
					as="span"
					role="label"
					tone="secondary"
					className="flex items-center justify-between gap-2"
				>
					{field.label}
					<Switch
						size="sm"
						aria-label={fieldLabel(field)}
						disabled={disabled}
						checked={slideFieldValue(element, field) === true}
						onCheckedChange={(checked) =>
							onChange(writeSlideField(element, field, String(checked)))
						}
					/>
				</Text>
			);
		case "prop-text":
		case "highlight":
		case "items":
			return (
				<TextPropField
					field={field}
					element={element}
					disabled={disabled}
					onChange={onChange}
				/>
			);
		case "color":
		case "prop-color":
			return (
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					{field.label}
					<Input
						type="color"
						aria-label={fieldLabel(field)}
						disabled={disabled}
						value={
							(slideFieldValue(element, field) as string | undefined) ??
							field.fallback
						}
						onChange={(event) =>
							onChange(writeSlideField(element, field, event.target.value))
						}
					/>
				</Text>
			);
		case "select":
		case "prop-select":
		case "font": {
			const fontFamily = element.style.fontFamily;
			const options: readonly (readonly [string, string])[] =
				field.kind === "font"
					? [
							[DEFAULT_FONT, "Default"],
							...SLIDE_FONT_FAMILIES.map(
								([name, stack]) => [stack, name] as const,
							),
							...(fontFamily &&
							!SLIDE_FONT_FAMILIES.some(([, stack]) => stack === fontFamily)
								? [[fontFamily, fontFamily.split(",")[0]!] as const]
								: []),
						]
					: field.options.map((option) => [option, option] as const);
			const value =
				field.kind === "font"
					? (fontFamily ?? DEFAULT_FONT)
					: ((slideFieldValue(element, field) as string | undefined) ??
						field.fallback);
			return (
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					{field.label}
					<Select
						disabled={disabled}
						value={value}
						onValueChange={(next) => {
							if (typeof next !== "string") return;
							onChange(
								writeSlideField(
									element,
									field,
									next === DEFAULT_FONT ? "" : next,
								),
							);
						}}
					>
						<SelectTrigger aria-label={fieldLabel(field)}>
							<SelectValue>
								{(current: string) =>
									options.find(([option]) => option === current)?.[1] ?? current
								}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{options.map(([option, label]) => (
								<SelectItem
									key={option}
									value={option}
									className="capitalize"
									style={
										field.kind === "font" && option !== DEFAULT_FONT
											? { fontFamily: option }
											: undefined
									}
								>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Text>
			);
		}
		case "text":
			return (
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					{field.label}
					<Input
						aria-label={fieldLabel(field)}
						maxLength={500}
						disabled={disabled}
						value={element.text ?? ""}
						onChange={(event) =>
							onChange(writeSlideField(element, field, event.target.value))
						}
					/>
				</Text>
			);
		case "image-url": {
			const linked = safeImageSource(element.src)?.startsWith("https://");
			return (
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					{field.label}
					<Input
						type="url"
						aria-label="Element image URL"
						maxLength={2_048}
						disabled={disabled}
						placeholder={element.src && !linked ? "Uploaded image" : "https://"}
						value={urlDraft ?? (linked ? element.src : "")}
						onBlur={() => setUrlDraft(null)}
						onChange={(event) => {
							setUrlDraft(event.target.value);
							const src = event.target.value.trim();
							// Only an https URL is a usable image; keep the current one
							// while a new address is still being typed.
							if (src === "" || safeImageSource(src))
								onChange({ ...element, src: src || undefined });
						}}
					/>
				</Text>
			);
		}
	}
}

/**
 * The slides inspector: the slide's own settings, then the selected element's
 * fields for its type, and speaker notes. The content scrolls inside the
 * panel; the element's action row is pinned below it so it stays reachable.
 */
export function SlideInspector({
	slide,
	element,
	disabled,
	canMoveForward,
	canMoveBackward,
	onChangeSlide,
	onChangeElement,
	onAction,
	onImageFile,
	onBackgroundImageFile,
}: {
	slide: OsPresentationCanvasSlide;
	element: OsPresentationElement | null;
	disabled?: boolean;
	canMoveForward: boolean;
	canMoveBackward: boolean;
	onChangeSlide: (next: OsPresentationCanvasSlide) => void;
	onChangeElement: (next: OsPresentationElement) => void;
	onAction: (action: SlideElementAction) => void;
	onImageFile: (file: File) => void;
	onBackgroundImageFile: (file: File) => void;
}) {
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const fields = element ? slideInspectorFields(element.type) : null;
	return (
		<>
			<div className="slide-inspector-scroll grid min-h-0 content-start gap-3 overflow-y-auto p-3">
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					Slide name
					<Input
						id="slide-name"
						aria-label="Slide name"
						value={slide.name}
						disabled={disabled}
						onChange={(event) =>
							onChangeSlide({
								...slide,
								name: event.target.value.slice(0, 200),
							})
						}
					/>
				</Text>
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					Background
					<Input
						type="color"
						aria-label="Slide background"
						disabled={disabled}
						value={slide.background}
						onChange={(event) =>
							onChangeSlide({ ...slide, background: event.target.value })
						}
					/>
				</Text>
				<SlideBackgroundControls
					slide={slide}
					disabled={disabled}
					onChangeSlide={onChangeSlide}
					onBackgroundImageFile={onBackgroundImageFile}
				/>
				{element && fields ? (
					<section
						aria-label={`${element.type} element`}
						className="grid gap-3"
						data-inspector-element={element.type}
					>
						<Text role="body" weight="medium" className="m-0 capitalize">
							{element.type}
						</Text>
						{fields.basic.map((field) => (
							<InspectorField
								key={`${element.id}-${field.kind}-${field.label}`}
								field={field}
								element={element}
								disabled={disabled}
								onChange={onChangeElement}
							/>
						))}
						{(element.type === "image" || element.type === "svg") && (
							<SlideImageUploadButton
								label={element.src ? "Replace image" : "Upload image"}
								disabled={disabled}
								onFile={onImageFile}
							/>
						)}
						<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
							<CollapsibleTrigger className="w-full">
								<CaretRight
									size={11}
									className="slide-inspector-caret"
									data-open={advancedOpen || undefined}
								/>
								Advanced
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="slide-inspector-advanced grid grid-cols-2 gap-2 pt-2">
									{fields.advanced.map((field) => (
										<InspectorField
											key={`${field.kind}-${field.label}`}
											field={field}
											element={element}
											disabled={disabled}
											onChange={onChangeElement}
										/>
									))}
								</div>
							</CollapsibleContent>
						</Collapsible>
					</section>
				) : (
					<Text role="label" tone="secondary" className="m-0">
						Select an element to edit its type, colour and layout. Arrow keys
						nudge it; Shift moves 10 px.
					</Text>
				)}
				<Text as="label" role="label" tone="secondary" className="grid gap-1">
					Speaker notes
					<Textarea
						aria-label="Speaker notes"
						value={slide.notes ?? ""}
						disabled={disabled}
						maxLength={MAX_NOTES_LENGTH}
						onChange={(event) =>
							onChangeSlide({
								...slide,
								notes: event.target.value || undefined,
							})
						}
					/>
				</Text>
			</div>
			{element && (
				<div className="slide-inspector-actions grid grid-cols-4 gap-1 p-2">
					{(
						[
							["duplicate", "Duplicate element", Copy],
							["forward", "Bring forward", ArrowUp],
							["backward", "Send backward", ArrowDown],
							["delete", "Delete element", Trash],
						] as const
					).map(([action, label, Icon]) => (
						<Button
							key={action}
							type="button"
							size="icon-xs"
							variant="ghost"
							className="w-full"
							aria-label={label}
							title={label}
							disabled={
								disabled ||
								(action === "forward" && !canMoveForward) ||
								(action === "backward" && !canMoveBackward)
							}
							onClick={() => onAction(action)}
						>
							<Icon size={13} />
						</Button>
					))}
				</div>
			)}
		</>
	);
}
