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
	// Sentence-case is applied by callers via sentenceCase — no CSS capitalize.
	return (
		<Badge variant={CHIP_VARIANTS[tone]} data-tone={tone}>
			{children}
		</Badge>
	);
}
