interface StarRatingProps {
	value: number;
	count?: number | null;
	gap?: "gap-1" | "gap-1.5";
	countSize?: "text-xs" | "text-sm";
}

export function StarRating({
	value,
	count,
	gap = "gap-1.5",
	countSize = "text-sm",
}: StarRatingProps) {
	const fullStars = Math.floor(value);
	const hasHalf = value - fullStars >= 0.5;

	return (
		<div className={`flex items-center ${gap}`}>
			<div
				className="flex text-amber-400"
				aria-label={`${value} out of 5 stars`}
			>
				{Array.from({ length: 5 }, (_, i) => (
					<span
						key={i}
						className={
							i < fullStars
								? ""
								: i === fullStars && hasHalf
									? "opacity-50"
									: "opacity-20"
						}
					>
						★
					</span>
				))}
			</div>
			{count != null && (
				<span className={`${countSize} text-muted-foreground`}>({count})</span>
			)}
		</div>
	);
}
