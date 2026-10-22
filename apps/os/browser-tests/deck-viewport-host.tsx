import { DeckFooterContext } from "@/components/deck-presentation-context";
import { createRoot } from "react-dom/client";
import { WorkDecisionCard } from "@/components/work-decision-card";
import {
	FeedDeckDisclosure,
	ProposerContext,
} from "@/components/feed-deck-primitives";
import { Button } from "@/components/kumo/button";
import { useDeckViewport } from "@/lib/use-deck-viewport";
import "@/styles.css";

// The reported production proposal, with the source link anonymized.
const proposal = `Open https://example.invalid/admin → Pages → home (English), review draft version92 (only final CTA to 'Ready to deploy your first tedi?'), and publish via the supported human admin flow. Automated approval review rejected pages publication because the current lane cannot publish this page. Review the complete draft and confirm the exact content before continuing.`;
function RegressionDeck() {
	const ref = useDeckViewport();
	return (
		<main
			style={{
				height: "100dvh",
				display: "flex",
				flexDirection: "column",
				paddingTop: "56px",
			}}
		>
			<section
				data-slot="page"
				style={{
					minHeight: 0,
					flex: 1,
					overflow: "auto",
					padding: "20px 1rem",
				}}
			>
				<nav
					className="hidden sm:block"
					style={{ height: 52, marginBottom: 20 }}
				>
					Feed · Deck
				</nav>
				<div
					ref={ref}
					className="feed-deck fd-deck mx-auto grid w-full min-w-0"
				>
					<div className="flex items-center justify-between">
						<div>1 of 14 · 0/7 today</div>
						<FeedDeckDisclosure
							className="fd-deck-filters"
							title="Find a decision"
						>
							<div className="fd-deck-toolbar">
								<Button>For you</Button>
								<Button>What you decided</Button>
							</div>
						</FeedDeckDisclosure>
					</div>
					<div className="fd-deck-current">
						<ProposerContext.Provider
							value={{
								project: "Example Website Publishing Platform",
								actor: { type: "external_agent", harness: "codex" },
							}}
						>
							<div className="fd-decision-stack" data-has-next="true">
								<div className="grid min-w-0 gap-3">
									<DeckFooterContext.Provider
										value={
											<Button variant="outline" data-deck-later>
												Later
											</Button>
										}
									>
										<WorkDecisionCard
											kind="proposal"
											title={proposal}
											askedBy="Codex session"
											at="2026-10-18T00:39:00Z"
											body={proposal.repeat(6)}
											why={<p>{proposal.repeat(4)}</p>}
											actions={[
												{ id: "approve", label: "Approve", intent: "approve" },
												{ id: "reject", label: "Not this", intent: "reject" },
											]}
											onDecision={async () => {
												throw new Error("Read-only regression");
											}}
										/>
									</DeckFooterContext.Provider>
								</div>
							</div>
						</ProposerContext.Provider>
					</div>
					<FeedDeckDisclosure title="Learning your preferences">
						Recent loaded history only.
					</FeedDeckDisclosure>
					<a href="#history">More history and decisions in Work</a>
					<a href="#profile">Your style profile</a>
				</div>
			</section>
			<nav
				data-slot="bottom-nav"
				className="flex shrink-0 sm:hidden"
				style={{ minHeight: 49 }}
			>
				Feed · Deck
			</nav>
		</main>
	);
}
createRoot(document.getElementById("root")!).render(<RegressionDeck />);
