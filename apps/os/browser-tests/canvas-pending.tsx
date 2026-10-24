import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "../src/components/canvas-page.css";
import { CanvasPending } from "../src/routes/-pending";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

createRoot(document.getElementById("root")!).render(<CanvasPending />);
