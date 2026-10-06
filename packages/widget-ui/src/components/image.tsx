import * as React from "react";
import { cn } from "../lib/utils";
import { Skeleton } from "./skeleton";

/**
 * Global cache of successfully loaded image sources.
 * Allows skipping loading state for previously loaded images.
 */
const loadedImageCache = new Set<string>();

export interface ImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
	fallback?: string;
	aspectRatio?: "square" | "video" | "portrait" | "auto";
	objectFit?: "cover" | "contain" | "fill" | "none";
	/**
	 * Force rendering the broken image even after a load failure.
	 * When false (default), falls back to the fallback image on error.
	 * When true, renders the original src even if it failed to load.
	 * @default false
	 */
	forceRenderAfterLoadFail?: boolean;
	/**
	 * Whether the image is draggable.
	 * Matches apps-sdk-ui default behavior.
	 * @default false
	 */
	draggable?: boolean;
}

const aspectRatioClasses = {
	square: "aspect-square",
	video: "aspect-video",
	portrait: "aspect-[3/4]",
	auto: "",
};

function Image({
	className,
	src,
	alt,
	fallback = "/placeholder.svg",
	aspectRatio = "auto",
	objectFit = "cover",
	forceRenderAfterLoadFail = false,
	draggable = false,
	...props
}: ImageProps) {
	// Skip loading state if image was previously loaded successfully
	const isAlreadyCached =
		typeof src === "string" ? loadedImageCache.has(src) : false;
	const [isLoading, setIsLoading] = React.useState(!isAlreadyCached);
	const [hasError, setHasError] = React.useState(false);

	// Reset state when src changes
	React.useEffect(() => {
		if (typeof src === "string") {
			const cached = loadedImageCache.has(src);
			setIsLoading(!cached);
			setHasError(false);
		}
	}, [src]);

	const handleLoad = () => {
		setIsLoading(false);
		// Cache successfully loaded images
		if (typeof src === "string") {
			loadedImageCache.add(src);
		}
	};

	const handleError = () => {
		setIsLoading(false);
		setHasError(true);
	};

	// If forceRenderAfterLoadFail is true, keep original src even on error
	const imageSrc = hasError && !forceRenderAfterLoadFail ? fallback : src;

	return (
		<div
			className={cn(
				"relative overflow-hidden bg-muted",
				aspectRatioClasses[aspectRatio],
				className,
			)}
		>
			{isLoading && <Skeleton className="absolute inset-0" />}
			<img
				src={imageSrc}
				alt={alt}
				draggable={draggable}
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

export { Image };
