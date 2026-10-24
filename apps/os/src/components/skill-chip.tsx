import type { ReactNode } from "react";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";

export type ChipTone = "neutral" | "active" | "blocked" | "done" | "warn";

/** Chip tone → tinted Kumo Badge variant — same accent discipline as Apps. */
const CHIP_VARIANTS: Record<ChipTone, BadgeVariant> = {
	neutral: "outline",
	active: "info",
	blocked: "destructive",
	done: "success",
	warn: "warning",
};

export function SkillChip({
	tone,
	children,
}: {
	tone: ChipTone;
	children: ReactNode;
}) {
	return (
		<Badge
			variant={CHIP_VARIANTS[tone]}
			data-tone={tone}
			className="max-w-full max-sm:wrap-anywhere max-sm:whitespace-normal"
		>
			{children}
		</Badge>
	);
}
