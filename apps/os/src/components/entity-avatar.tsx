import "./entity-avatar.css";
import { useState } from "react";
import { Avatar } from "@/components/kumo/avatar";
import {
	entityAvatarColors,
	entityAvatarIndex,
	entityGlyph,
	entityInitials,
} from "@/lib/entity-avatar";
import { cn } from "@/lib/utils";

export function EntityAvatar({
	id,
	name,
	kind,
	image,
	role,
	alt,
	imageFit = "cover",
	className,
}: {
	id: string;
	name: string;
	kind: "workspace" | "tedi" | "person";
	image?: string | null;
	role?: string | null;
	/** Accessible name; without it the avatar is decoration beside its label. */
	alt?: string;
	/**
	 * `cover` fills the circle with a photo. `contain` sets a brand mark on a
	 * light tile inside the circle, so a transparent or bare glyph stays legible.
	 */
	imageFit?: "cover" | "contain";
	className?: string;
}) {
	const [failedImage, setFailedImage] = useState<string | null>(null);
	const imageUrl =
		image && /^(?:https?:\/\/|\/|data:image\/|blob:)/i.test(image)
			? image
			: null;
	const glyph =
		image && !imageUrl && [...image.trim()].length <= 4 ? image.trim() : null;
	const Icon = entityGlyph(kind, role || name);
	return (
		<Avatar
			aria-hidden={alt ? undefined : "true"}
			role={alt ? "img" : undefined}
			aria-label={alt}
			data-entity-kind={kind}
			data-avatar-palette={entityAvatarIndex(id)}
			className={cn(
				"entity-avatar items-center justify-center overflow-hidden ring-0",
				kind === "workspace" && "rounded-lg",
				// A light tile on a light row needs the standard avatar outline to
				// read as a circle at all.
				imageFit === "contain" && "ring ring-kumo-line",
				className,
			)}
			style={entityAvatarColors(id)}
		>
			{imageUrl && failedImage !== imageUrl ? (
				<img
					src={imageUrl}
					alt=""
					data-image-fit={imageFit}
					className={cn(
						"size-full rounded-[inherit]",
						imageFit === "contain"
							? "bg-white object-contain p-1"
							: "object-cover",
					)}
					onError={() => setFailedImage(imageUrl)}
				/>
			) : glyph ? (
				glyph
			) : Icon ? (
				<Icon className="size-3/5" weight="duotone" />
			) : (
				<span className="font-medium type-tedix-label">
					{entityInitials(name)}
				</span>
			)}
		</Avatar>
	);
}
