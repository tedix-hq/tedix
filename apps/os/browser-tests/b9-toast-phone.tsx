import { createRoot } from "react-dom/client";
import { Button } from "../src/components/kumo/button";
import { toast, Toaster } from "../src/components/kumo/toast";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const longTitle =
	"Workspace “Quarterly supplier onboarding and contract renewals” could not be created";
const longDescription =
	"The organization reached its workspace limit. Archive an unused workspace or ask an owner to raise the limit: https://example.com/settings/organization/limits/workspaces";

function Fixture() {
	return (
		<main style={{ padding: 16, display: "grid", gap: 8 }}>
			<Button onClick={() => toast.success("Workspace created")}>
				Raise success
			</Button>
			<Button
				onClick={() =>
					// Geometry and keyboard dismissal must survive a busy CI runner.
					// The spec checks the default timeout on the success toast.
					toast.error(longTitle, { description: longDescription, duration: 0 })
				}
			>
				Raise error
			</Button>
			<Button
				onClick={() =>
					toast.loading("Creating workspace", { id: "fixture-loading" })
				}
			>
				Raise loading
			</Button>
			<Button onClick={() => toast.dismiss("fixture-loading")}>
				Finish loading
			</Button>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<>
		<Fixture />
		<Toaster />
	</>,
);
