import { Link } from "@tanstack/react-router";
import { KumoTabs } from "@/components/kumo/tabs";
import type { AgentTab } from "@/lib/work-agent-navigation";

export function WorkAgentNavigation({ tabs }: { tabs: readonly AgentTab[] }) {
	return (
		<nav aria-label="Agents" className="min-w-0 px-tedix-gutter pt-4">
			<KumoTabs
				aria-label="Agent views"
				variant="underline"
				value={tabs.find((tab) => tab.active)?.id}
				tabs={tabs.map((tab) => ({
					value: tab.id,
					label: tab.label,
					nativeButton: false,
					render: (
						<Link
							to={tab.href}
							aria-current={tab.active ? "page" : undefined}
							preload="intent"
						/>
					),
				}))}
			/>
		</nav>
	);
}
