import type { ConnectionCapability } from "@tedix/api-contract/schemas/connections";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";

const stateLabels = {
	connected: "Connected",
	not_configured: "Not configured",
	needs_reauth: "Needs re-auth",
	not_supported: "Not supported",
} satisfies Record<ConnectionCapability["state"], string>;

export function ConnectionCapabilities({
	capabilities = [],
}: {
	capabilities?: readonly ConnectionCapability[];
}) {
	if (capabilities.length === 0) return null;
	return (
		<ul aria-label="Connection capabilities" className="grid gap-2 py-2">
			{capabilities.map((capability) => (
				<li
					key={capability.id}
					data-connection-capability={capability.id}
					className="flex flex-wrap items-center gap-2"
				>
					<Text as="span" role="label">
						{capability.label}
					</Text>
					<Badge
						variant={
							!capability.verified
								? "outline"
								: capability.state === "connected"
									? "success"
									: capability.state === "needs_reauth"
										? "warning"
										: "outline"
						}
					>
						{capability.verified
							? stateLabels[capability.state]
							: "Could not verify"}
					</Badge>
					{(capability.state === "not_configured" ||
						capability.state === "needs_reauth") && (
						<Link
							href={capability.setupUrl}
							aria-label={`Set up ${capability.label}`}
							className="inline-flex min-h-11 items-center"
						>
							Set up
						</Link>
					)}
					{capability.description && (
						<Text role="label" tone="secondary" className="w-full">
							{capability.description}
						</Text>
					)}
				</li>
			))}
		</ul>
	);
}
