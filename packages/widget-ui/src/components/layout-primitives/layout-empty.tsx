"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../button";

export interface LayoutEmptyProps {
	/**
	 * Icon to display (Lucide icon component)
	 */
	icon?: LucideIcon;

	/**
	 * Title text
	 */
	title: string;

	/**
	 * Description text
	 */
	description?: string;

	/**
	 * Action button label
	 */
	action?: string;

	/**
	 * Action button handler
	 */
	onAction?: () => void;

	/**
	 * Custom className
	 */
	className?: string;
}

/**
 * LayoutEmpty - Empty state component for layouts
 *
 * Displays a centered message with optional icon and action button.
 *
 * @example
 * ```tsx
 * import { Search } from "lucide-react";
 *
 * <LayoutEmpty
 *   icon={Search}
 *   title="No products found"
 *   description="Try adjusting your search or filter criteria"
 *   action="Clear filters"
 *   onAction={handleClearFilters}
 * />
 * ```
 */
export function LayoutEmpty({
	icon: Icon,
	title,
	description,
	action,
	onAction,
	className,
	...props
}: LayoutEmptyProps) {
	return (
		<div
			data-slot="layout-empty"
			className={cn(
				"flex flex-col items-center justify-center py-12 text-center",
				className,
			)}
			{...props}
		>
			{Icon && (
				<div className="mb-4">
					<Icon className="h-16 w-16 text-muted-foreground" />
				</div>
			)}
			<h3 className="mb-2 font-semibold text-foreground text-lg">{title}</h3>
			{description && (
				<p className="mb-6 max-w-md text-muted-foreground text-sm">
					{description}
				</p>
			)}
			{action && onAction && (
				<Button onClick={onAction} variant="outline">
					{action}
				</Button>
			)}
		</div>
	);
}
