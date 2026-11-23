import type { ReactNode } from "react";

/** A badge stays two digits wide: 100 and up reads "99+". */
export function tabBadgeText(count: number, more = false): string {
	return count > 99 ? "99+" : `${count}${more ? "+" : ""}`;
}

/**
 * One tab of a `tab-bar` row (see styles.css): the icon, a badge for a
 * positive count, the label, and the count as text for screen readers and
 * for wider screens where the row is not a phone bar.
 */
export function TabBarContent({
	icon,
	label,
	count,
	more = false,
	countTitle,
	countClassName,
}: {
	icon: ReactNode;
	label: ReactNode;
	/** Omit while the count is unknown. */
	count?: number | null;
	more?: boolean;
	countTitle?: string;
	countClassName?: string;
}) {
	const known = count !== undefined && count !== null;
	return (
		<>
			<span data-tab-icon aria-hidden="true">
				{icon}
				{known && count > 0 && (
					<span data-tab-badge>{tabBadgeText(count, more)}</span>
				)}
			</span>
			<span data-tab-label>{label}</span>
			{known && (
				<span data-tab-count title={countTitle} className={countClassName}>
					{count}
					{more ? "+" : ""}
				</span>
			)}
		</>
	);
}
