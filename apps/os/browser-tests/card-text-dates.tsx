import { createRoot } from "react-dom/client";
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
} from "../src/components/kumo/card";
import {
	formatCardTextDates,
	setOsFormattingPreferences,
	useOsFormattingPreferences,
} from "../src/lib/format";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
const raw = query.has("raw");
setOsFormattingPreferences({
	locale: query.get("locale"),
	timezone: query.get("timezone"),
});
function Fixture() {
	useOsFormattingPreferences();
	const render = (text: string) => (raw ? text : formatCardTextDates(text));
	return (
		<main className="mx-auto max-w-xl p-4 sm:p-8">
			<Card>
				<CardHeader>
					<CardTitle>Keep the repository private?</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<p data-calendar>
						{render(
							"The repository cannot be checked; review it by 2026-10-20.",
						)}
					</p>
					<p data-instant>{render("Review opens on 2026-10-20T00:30:00Z.")}</p>
					<p data-next>{render("Next review: 2027-01-02.")}</p>
				</CardContent>
			</Card>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
