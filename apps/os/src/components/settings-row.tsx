import {
	createElement,
	type ComponentProps,
	type ComponentType,
	type ReactNode,
} from "react";
import { Card } from "@/components/kumo/card";
import { IconFrame } from "@/components/kumo/icon-frame";
import { cn } from "@/lib/utils";

export function SettingsRows({
	className,
	...props
}: ComponentProps<typeof Card>) {
	return (
		<Card
			className={cn(
				"gap-0 divide-y divide-kumo-line overflow-visible p-0",
				className,
			)}
			{...props}
		/>
	);
}

export function SettingsRow({
	icon,
	title,
	description,
	children,
	className,
}: {
	icon?: ComponentType<{ size?: number }> | ReactNode;
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	const iconContent =
		typeof icon === "function" ||
		(icon &&
			typeof icon === "object" &&
			"$$typeof" in icon &&
			(icon.$$typeof === Symbol.for("react.forward_ref") ||
				icon.$$typeof === Symbol.for("react.memo")))
			? createElement(icon as ComponentType<{ size?: number }>, { size: 18 })
			: icon;
	return (
		<div
			className={cn(
				"grid items-start gap-x-3 gap-y-3 px-4 py-4 sm:items-center",
				icon
					? "grid-cols-[2.25rem_minmax(0,1fr)] sm:grid-cols-[2.25rem_minmax(0,1fr)_auto]"
					: "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]",
				className,
			)}
			data-slot="setting-row"
		>
			{icon ? <IconFrame appearance="fill">{iconContent}</IconFrame> : null}
			<div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
				<div
					className="font-medium text-kumo-default type-tedix-body"
					data-slot="setting-row-title"
				>
					{title}
				</div>
				{description ? (
					<div
						className="mt-1 text-kumo-subtle type-tedix-label"
						data-slot="setting-row-description"
					>
						{description}
					</div>
				) : null}
			</div>
			{children ? (
				<div
					className={cn(
						"min-w-0 max-w-full justify-self-stretch sm:col-span-1 sm:shrink-0 sm:justify-self-end",
						icon && "col-start-2 sm:col-start-3",
					)}
					data-slot="setting-row-control"
				>
					{children}
				</div>
			) : null}
		</div>
	);
}
