import type { DirectoryWorkspaceRecord } from "@tedix/api-contract/contracts/directory";
import { createRoot } from "react-dom/client";
import { OrganizationSwitcherMenu } from "../src/components/os-workspace-switcher";
import "../src/styles.css";

// The real switcher menu over twelve fictional organizations. Every third one
// has a CMS; "Lantern Books" is still setting up. Switches are recorded on
// `window.switches` instead of navigating.
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const NAMES = [
	"Alder Works",
	"Birch Studio",
	"Cedar Supply",
	"Dune Freight",
	"Elm Clinic",
	"Fjord Bakery",
	"Granite Legal Partners and Associates International",
	"Harbor Kitchen",
	"Iris Dental",
	"Juniper Farms",
	"Kestrel Air",
	"Lantern Books",
];

const workspaces: DirectoryWorkspaceRecord[] = NAMES.map((name, index) => {
	const slug = name.split(" ")[0]!.toLowerCase();
	const provisionComplete = name !== "Lantern Books";
	const cms = provisionComplete && index % 3 === 0;
	return {
		org: {
			descopeTenantId: provisionComplete ? `org_${slug}` : null,
			logoUrl: null,
			name,
			organizationId: `0f0f0f0f-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			provisionComplete,
			slug,
		},
		surfaces: [
			{
				canonicalUrl: provisionComplete
					? `https://${slug}.os.example.test/`
					: null,
				handoffUrl: null,
				provisioned: provisionComplete,
				surface: "os",
			},
			{
				canonicalUrl: cms ? `https://${slug}.cms.example.test/` : null,
				handoffUrl: null,
				provisioned: cms,
				surface: "cms",
			},
		],
	};
});

const switches: string[] = [];
(window as unknown as { switches: string[] }).switches = switches;

createRoot(document.getElementById("root")!).render(
	<div className="h-dvh w-64 max-w-full bg-kumo-base p-2 text-kumo-default">
		<OrganizationSwitcherMenu
			currentSlug="harbor"
			isError={false}
			isLoading={false}
			onSwitch={(workspace, surface) =>
				switches.push(`${workspace.org.slug}:${surface}`)
			}
			workspaces={workspaces}
		>
			<span className="truncate font-semibold">Harbor Kitchen</span>
		</OrganizationSwitcherMenu>
	</div>,
);
