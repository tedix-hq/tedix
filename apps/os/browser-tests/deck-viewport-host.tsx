import { createRoot } from "react-dom/client";
import { WorkDecisionCard } from "@/components/work-decision-card";
import { ProposerProjectContext } from "@/components/feed-deck-primitives";
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
				paddingTop: "8rem",
			}}
		>
			<section
				data-slot="page"
				style={{
					minHeight: 0,
					flex: 1,
					overflow: "auto",
					padding: "0 1rem 1rem",
				}}
			>
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
						<button>For you</button>
					</div>
					<div className="fd-deck-current">
						<p>Your call · 1 of 14</p>
						<ProposerProjectContext.Provider value="Website">
							<div className="fd-decision-stack" data-has-next="true">
								<WorkDecisionCard
									kind="proposal"
									title={proposal}
									askedBy="Codex session"
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
						</ProposerProjectContext.Provider>
					</div>
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
