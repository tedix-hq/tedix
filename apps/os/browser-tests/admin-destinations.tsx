import { createRoot } from "react-dom/client";
import { Buildings } from "@phosphor-icons/react";
import { AdminLinkRow } from "../src/components/admin-page";
import { Collection, Page, PageSection } from "../src/components/kumo/page";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const statusDetail =
	"Credential or reference verification is incomplete; provider health is unknown.";
const narrowToken =
	"tenant-org-0000aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666";

createRoot(document.getElementById("root")!).render(
	<Page width="md">
		<PageSection>
			<Collection aria-label="At a glance">
				<AdminLinkRow
					to="/admin/connections"
					title="Connection credentials"
					description={statusDetail}
					status={{
						label: "Partial",
						variant: "secondary",
						detail: statusDetail,
					}}
				/>
			</Collection>
		</PageSection>
		<PageSection>
			<Collection aria-label="Manage settings">
				<AdminLinkRow
					to="/admin/organization"
					title="Organization"
					description="Profile, plan features, identity, and single sign-on"
					icon={Buildings}
				/>
				<AdminLinkRow
					to="/admin/api-keys"
					title="API keys"
					description={narrowToken}
					icon={Buildings}
				/>
			</Collection>
		</PageSection>
	</Page>,
);
