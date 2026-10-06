interface EmptyStateProps {
	title: string;
	description?: string | null;
	icon?: string | null;
	actionLabel?: string | null;
	action?: string | null;
	onAction?: () => void;
}

export function EmptyStateComponent({
	title,
	description,
	icon: _icon,
	action: _action,
	actionLabel,
	onAction,
}: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center justify-center py-12 text-center">
			<div className="rounded-full bg-muted p-4 mb-4">
				<svg
					className="h-8 w-8 text-muted-foreground"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					strokeWidth={1.5}
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
					/>
				</svg>
			</div>
			<h3 className="text-lg font-semibold text-foreground">{title}</h3>
			{description && (
				<p className="mt-1 max-w-sm text-sm text-muted-foreground">
					{description}
				</p>
			)}
			{actionLabel && (
				<button
					type="button"
					onClick={onAction}
					className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
				>
					{actionLabel}
				</button>
			)}
		</div>
	);
}
