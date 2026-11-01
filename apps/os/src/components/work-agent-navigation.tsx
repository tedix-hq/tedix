import { Link } from "@/components/kumo/link";
import type { AgentTab } from "@/lib/work-agent-navigation";

export function WorkAgentNavigation({ tabs }: { tabs: readonly AgentTab[] }) {
	return (
		<nav aria-label="Agents" className="flex flex-wrap gap-1 px-4 pt-4 sm:px-6">
			{tabs.map((tab) => (
				<Link
					key={tab.id}
					href={tab.href}
					variant="navigation"
					aria-current={tab.active ? "page" : undefined}
					className="min-h-11"
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}
