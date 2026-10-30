import { createRoot } from "react-dom/client";
import { buildLauncherWorkspacesFromDirectory } from "../src/account/launcher-routing";
import { OrganizationLauncherContent } from "../src/account/organization-launcher-page";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const workspaces = buildLauncherWorkspacesFromDirectory(
	["Saved Logo", "Missing Logo", "Broken Logo", "Setting Up"].map(
		(name, index) => {
			const slug = name.toLowerCase().replaceAll(" ", "-");
			const provisioned = index !== 3;
			return {
				org: {
					organizationId: `fixture-${index}`,
					name,
					slug,
					logoUrl:
						index === 0
							? "/fixture-logo.svg"
							: index === 2
								? "/fixture-broken-logo.png"
								: null,
					descopeTenantId: provisioned ? `tenant-${index}` : null,
					provisionComplete: provisioned,
				},
				surfaces: [
					{
						surface: "os" as const,
						canonicalUrl: `https://${slug}.os.example.test/`,
						handoffUrl: `https://${slug}.os.example.test/`,
						provisioned,
					},
				],
			};
		},
	),
);

createRoot(document.getElementById("root")!).render(
	<div className="text-kumo-default">
		<OrganizationLauncherContent
			workspaces={workspaces}
			email="reader@example.test"
		/>
	</div>,
);
