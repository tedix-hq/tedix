import type { OsPresentationCanvasSlide } from "@tedix/api-contract/schemas/os-workspaces";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Switch } from "@/components/kumo/switch";
import { SlideField, SlideImageUrlField } from "@/components/slide-field";
import { SlideImageUploadButton } from "@/components/slide-insert-library";

/** The inset surface the toggle adds: the schema's own defaults. */
const SLIDE_INSET_SURFACE = { color: "#ffffff", inset: 24, radius: 8 };

/** Dot grid opacity from a typed value: cleared when empty or zero. */
function slideDotGridOpacity(raw: string): number | undefined {
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
	return (
		<>
			<SlideField label="Background">
				<Input
					type="color"
					aria-label="Slide background"
					disabled={disabled}
					value={slide.background}
					onChange={(event) =>
						onChangeSlide({ ...slide, background: event.target.value })
					}
				/>
			</SlideField>
			<SlideField label="Dot grid opacity">
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
			</SlideField>
			<SlideField label="Inset surface" inline>
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
			</SlideField>
			<SlideImageUrlField
				label="Background image URL"
				ariaLabel="Slide background image URL"
				src={image}
				disabled={disabled}
				onChange={(backgroundImage) =>
					onChangeSlide({ ...slide, backgroundImage })
				}
			/>
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
