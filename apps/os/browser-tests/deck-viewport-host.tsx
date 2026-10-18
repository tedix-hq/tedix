import { createRoot } from "react-dom/client";
import { WorkDecisionCard } from "@/components/work-decision-card";
import {
	FeedDeckDisclosure,
	ProposerProjectContext,
} from "@/components/feed-deck-primitives";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
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
				<nav style={{ height: 52, marginBottom: 20 }}>Feed · Deck</nav>
				<div
					ref={ref}
					className="feed-deck fd-deck mx-auto grid w-full min-w-0"
				>
					<header className="fd-deck-heading">
						<h2>One decision at a time</h2>
						<p>Make a few choices, then get back to your day.</p>
					</header>
					<div className="fd-deck-progress">14 left</div>
					<div className="fd-deck-toolbar">
						<Button>For you</Button>
						<Button>What you decided</Button>
					</div>
					<FeedDeckDisclosure
						className="fd-deck-filters"
						title="Find a decision"
					>
						Filters
					</FeedDeckDisclosure>
					<div className="fd-deck-current">
						<Text>Your call · 1 of 14</Text>
						<ProposerProjectContext.Provider value="Example Website Publishing Platform">
							<div className="fd-decision-stack" data-has-next="true">
								<div className="grid min-w-0 gap-3">
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
											{ id: "later", label: "Later", intent: "later" },
										]}
										onDecision={async () => {
											throw new Error("Read-only regression");
										}}
									/>
								</div>
							</div>
						</ProposerProjectContext.Provider>
						<Button variant="outline">Later</Button>
					</div>
					<FeedDeckDisclosure
						className="fd-deck-learning"
						title="Learning your preferences"
					>
						Recent loaded history only.
					</FeedDeckDisclosure>
					<a href="#history">More history and decisions in Work</a>
					<p className="fd-deck-shortcuts">
						← Not this · → Approve · E Change · L Later
					</p>
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
