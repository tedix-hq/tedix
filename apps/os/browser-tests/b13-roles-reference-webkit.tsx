import { createRoot } from "react-dom/client";
import {
	CapabilityScopeReference,
	RolePermissionsMatrix,
} from "../src/components/team-roles";
import "../src/styles.css";

// Mounts the real Roles reference components against the canonical role and
// scope metadata they import; no API, router or fixture data is involved.
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
	<main style={{ padding: 16, display: "grid", gap: 32 }}>
		<RolePermissionsMatrix />
		<CapabilityScopeReference />
	</main>,
);
