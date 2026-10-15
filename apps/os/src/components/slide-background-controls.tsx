import type { OsPresentationCanvasSlide } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { SlideImageUploadButton } from "@/components/slide-insert-library";
import { safeImageSource } from "@/lib/output-models";

/** The inset surface the toggle adds: the schema's own defaults. */
export const SLIDE_INSET_SURFACE = { color: "#ffffff", inset: 24, radius: 8 };

/** Dot grid opacity from a typed value: cleared when empty or zero. */
export function slideDotGridOpacity(raw: string): number | undefined {
	const value = Number(raw);
	if (raw === "" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(1, value);
}

/**
 * The slide's background layers after C3's slide model: an image under a dot
 * grid under an inset surface, all drawn by `slideBackgroundMarkup`.
 */
export function SlideBackgroundControls({
	slide,
	disabled,
	onChangeSlide,
	onBackgroundImageFile,
}: {
	slide: OsPresentationCanvasSlide;
	disabled?: boolean;
	onChangeSlide: (next: OsPresentationCanvasSlide) => void;
	onBackgroundImageFile: (file: File) => void;
}) {
	const [opacityDraft, setOpacityDraft] = useState<string | null>(null);
	const image = slide.backgroundImage;
	const linked = safeImageSource(image)?.startsWith("https://");
	return (
		<>
			<Text as="label" role="label" tone="secondary" className="grid gap-1">
				Dot grid opacity
				<Input
					type="number"
					aria-label="Slide dot grid opacity"
					min={0}
					max={1}
					step={0.05}
					placeholder="0"
					disabled={disabled}
					value={opacityDraft ?? String(slide.dotGridOpacity ?? "")}
					onChange={(event) => {
						setOpacityDraft(event.target.value);
						onChangeSlide({
							...slide,
							dotGridOpacity: slideDotGridOpacity(event.target.value),
						});
					}}
					onBlur={() => setOpacityDraft(null)}
				/>
			</Text>
			<Text
				as="span"
				role="label"
				tone="secondary"
				className="flex items-center justify-between gap-2"
			>
				Inset surface
				<Switch
					size="sm"
					aria-label="Slide inset surface"
					disabled={disabled}
					checked={slide.insetSurface !== undefined}
					onCheckedChange={(checked) =>
						onChangeSlide({
							...slide,
							insetSurface: checked ? SLIDE_INSET_SURFACE : undefined,
						})
					}
				/>
			</Text>
			<Text as="label" role="label" tone="secondary" className="grid gap-1">
				Background image URL
				<Input
					type="url"
					aria-label="Slide background image URL"
					maxLength={2_048}
					disabled={disabled}
					placeholder={image && !linked ? "Uploaded image" : "https://"}
					value={linked ? image : ""}
					onChange={(event) => {
						const src = event.target.value.trim();
						// Keep the current image while a new address is still being typed.
						if (src === "" || safeImageSource(src))
							onChangeSlide({ ...slide, backgroundImage: src || undefined });
					}}
				/>
			</Text>
			<div className="flex flex-wrap gap-2">
				<SlideImageUploadButton
					label={image ? "Replace background image" : "Upload background image"}
					disabled={disabled}
					onFile={onBackgroundImageFile}
				/>
				{image && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={disabled}
						onClick={() =>
							onChangeSlide({ ...slide, backgroundImage: undefined })
						}
					>
						Remove image
					</Button>
				)}
			</div>
		</>
	);
}
