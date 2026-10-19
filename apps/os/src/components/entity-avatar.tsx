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
	className,
}: {
	id: string;
	name: string;
	kind: "workspace" | "tedi" | "person";
	image?: string | null;
	role?: string | null;
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
			aria-hidden="true"
			data-entity-kind={kind}
			data-avatar-palette={entityAvatarIndex(id)}
			className={cn(
				"entity-avatar items-center justify-center overflow-hidden ring-0",
				kind === "workspace" && "rounded-lg",
				className,
			)}
			style={entityAvatarColors(id)}
		>
			{imageUrl && failedImage !== imageUrl ? (
				<img
					src={imageUrl}
					alt=""
					className="size-full rounded-[inherit] object-cover"
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
