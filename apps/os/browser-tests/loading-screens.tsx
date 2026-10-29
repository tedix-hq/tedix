import { createRoot } from "react-dom/client";
import { IdentityJourneyFrame } from "../src/account/identity-journey";
import { OsRoutePending } from "../src/components/os-route-boundaries";
import { ListSkeleton } from "../src/components/list-skeleton";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
	"dark",
	params.get("theme") === "dark",
);
const state = params.get("state");

createRoot(document.getElementById("root")!).render(
	state === "route" ? (
		<OsRoutePending />
	) : state === "section" ? (
		<section style={{ width: 280, padding: 24 }} aria-label="Loading list">
			<ListSkeleton />
		</section>
	) : (
		<IdentityJourneyFrame
			title="Sign in"
			description="Continue to your workspace."
			loading
			loadingLabel={
				state === "finishing" ? "Finishing your Tedix sign-in…" : undefined
			}
		>
			<button type="button">Sign in</button>
		</IdentityJourneyFrame>
	),
);
