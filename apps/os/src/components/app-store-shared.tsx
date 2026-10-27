import {
	CheckCircle,
	Pulse,
	Shield,
	WarningCircle,
	XCircle,
} from "@phosphor-icons/react";
import { Badge } from "@/components/kumo/badge";

export const CATALOG_HEALTH = {
	healthy: {
		label: "Catalog check passed",
		variant: "success" as const,
		icon: CheckCircle,
	},
	degraded: {
		label: "Degraded",
		variant: "secondary" as const,
		icon: WarningCircle,
	},
	unhealthy: {
		label: "Unhealthy",
		variant: "destructive" as const,
		icon: XCircle,
	},
	requires_auth: {
		label: "Requires auth",
		variant: "outline" as const,
		icon: Shield,
	},
	blocked: {
		label: "Blocked",
		variant: "destructive" as const,
		icon: XCircle,
	},
	unsupported: {
		label: "Unsupported",
		variant: "outline" as const,
		icon: WarningCircle,
	},
	unknown: {
		label: "Not checked",
		variant: "outline" as const,
		icon: Pulse,
	},
};

export function CatalogHealthBadge({ status }: { status: string | null }) {
	const config =
		CATALOG_HEALTH[status as keyof typeof CATALOG_HEALTH] ??
		CATALOG_HEALTH.unknown;
	const Icon = config.icon;
	return (
		<Badge variant={config.variant} className="gap-1">
			<Icon aria-hidden className="size-3" />
			{config.label}
		</Badge>
	);
}
