import { createContext, useContext } from "react";
import { Badge } from "@/components/kumo/badge";
import { cn } from "@/lib/utils";

/** A count of new items; renders nothing at zero. */
export function UnreadBadge({
	count,
	label,
	className,
}: {
	count: number;
	/** What is being counted, for screen readers: "unread in Launch". */
	label: string;
	className?: string;
}) {
	if (count <= 0) return null;
	return (
		<Badge
			aria-label={`${count} ${label}`}
			className={cn(
				"h-4 min-w-4 shrink-0 justify-center rounded-full px-1 tabular-nums",
				className,
			)}
			variant="info"
		>
			{count > 99 ? "99+" : count}
		</Badge>
	);
}

/** A small dot for "this changed since you last opened it". */
export function UnreadDot({ label }: { label: string }) {
	return (
		<span
			aria-label={label}
			className="inline-block size-2 shrink-0 rounded-full bg-kumo-info"
			role="img"
			title={label}
		/>
	);
}

const NO_FILES: ReadonlySet<string> = new Set();

/** Ids of the files in the workspace on screen that changed since the person last opened them. */
export const UnreadFilesContext = createContext<ReadonlySet<string>>(NO_FILES);

/** The dot next to a file someone else changed; nothing for any other file. */
export function FileUnreadDot({ outputId }: { outputId?: string | null }) {
	const unread = useContext(UnreadFilesContext);
	return outputId && unread.has(outputId) ? (
		<UnreadDot label="Changed since you last opened it" />
	) : null;
}
