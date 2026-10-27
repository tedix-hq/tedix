import { useState } from "react";
import { EntityAvatar } from "@/components/entity-avatar";
import { type AppIconSource, appIconCandidates } from "@/lib/app-icon";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
	sm: "size-8",
	md: "size-9",
	lg: "size-10",
	xl: "size-16 rounded-xl",
} as const;

/**
 * An app's logo on every app surface. Tries each logo in the shared order and
 * moves to the next one when an image fails, ending at a letter avatar.
 */
export function AppLogo({
	id,
	name,
	size = "md",
	decorative = false,
	className,
	...source
}: AppIconSource & {
	/** Stable key for the shared avatar palette: the app's slug or id. */
	id: string;
	name: string;
	size?: keyof typeof SIZE_CLASSES;
	/** True when the app's name is already read beside the logo. */
	decorative?: boolean;
	className?: string;
}) {
	const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
	const image =
		appIconCandidates(source).find((url) => !failed.has(url)) ?? null;
	return (
		<EntityAvatar
			key={image ?? "letters"}
			kind="app"
			id={id}
			name={name}
			image={image}
			imageFit="contain"
			alt={decorative ? undefined : `${name} logo`}
			onImageError={(url) => setFailed((current) => new Set(current).add(url))}
			className={cn(SIZE_CLASSES[size], "shrink-0", className)}
		/>
	);
}
