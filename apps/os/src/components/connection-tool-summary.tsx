import type { ConnectionToolCapability } from "@tedix/api-contract/schemas/connections";
import { Text } from "@/components/kumo/text";

type CapabilityGroup = {
	key: "read" | "write" | "protected";
	label: string;
	suffix: string;
};

const groups: CapabilityGroup[] = [
	{ key: "read", label: "Read", suffix: "Automatic." },
	{
		key: "write",
		label: "Create and edit",
		suffix: "Automatic, logged.",
	},
	{
		key: "protected",
		label: "Protected effects",
		suffix: "Asks a person first.",
	},
];

function groupKey(
	riskTier: ConnectionToolCapability["riskTier"],
): CapabilityGroup["key"] {
	if (riskTier === "read") return "read";
	if (riskTier === "bounded_write") return "write";
	return "protected";
}

function shortList(labels: readonly string[]): string {
	const unique = [
		...new Set(labels.map((label) => label.trim()).filter(Boolean)),
	];
	return unique.length <= 4
		? unique.join(", ")
		: `${unique.slice(0, 4).join(", ")} and ${unique.length - 4} more`;
}

/**
 * What apps can do through a connection, grouped by how much it asks of a
 * person. Renders nothing when no actions are known; the safety note is for
 * the moment someone decides to connect, not for every look at a row.
 */
export function ConnectionToolSummary({
	providerName,
	capabilities = [],
	safetyNote = false,
}: {
	providerName: string;
	capabilities?: readonly ConnectionToolCapability[];
	safetyNote?: boolean;
}) {
	const visibleGroups = groups.flatMap((group) => {
		const labels = capabilities
			.filter((capability) => groupKey(capability.riskTier) === group.key)
			.map((capability) => capability.label);
		return labels.length ? [{ ...group, capabilities: shortList(labels) }] : [];
	});
	if (!visibleGroups.length && !safetyNote) return null;

	return (
		<section className="grid gap-2" aria-label="What Tedix can do with it">
			{visibleGroups.length > 0 && (
				<>
					<Text weight="medium">What Tedix can do with it</Text>
					<ul className="m-0 grid list-disc gap-1 ps-5 type-tedix-body">
						{visibleGroups.map((group) => (
							<li key={group.key} data-capability-group={group.key}>
								<strong>{group.label}:</strong> {group.capabilities}.{" "}
								<span className="text-kumo-subtle">{group.suffix}</span>
							</li>
						))}
					</ul>
				</>
			)}
			{safetyNote && (
				<Text role="body" tone="secondary">
					Tedix keeps your {providerName} key; your tedis and AI tools never see
					it. Anything risky waits for a person to approve. Every action is
					logged.
				</Text>
			)}
		</section>
	);
}
