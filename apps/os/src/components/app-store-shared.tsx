import {
	CheckCircle,
	Pulse,
	Shield,
	WarningCircle,
	XCircle,
} from "@phosphor-icons/react";
import { EntityAvatar } from "@/components/entity-avatar";
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

export function CatalogAppLogo({
	id,
	logoUrl,
	name,
	size = "small",
}: {
	/** Stable key for the shared avatar palette: the app's slug or id. */
	id: string;
	logoUrl: string | null;
	name: string;
	size?: "small" | "large";
}) {
	return (
		<EntityAvatar
			kind="workspace"
			id={id}
			name={name}
			image={logoUrl}
			imageFit="contain"
			alt={`${name} logo`}
			className={size === "large" ? "size-16 rounded-xl" : "size-10 rounded-lg"}
		/>
	);
}
