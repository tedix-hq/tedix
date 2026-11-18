import { apiFetch } from "emdash/plugin-utils";
import { useEffect, useState, type ComponentType } from "react";

function SiteDevelopmentPage() {
	return (
		<section>
			<h1>Code and deployments</h1>
			<PublishDeliveries />
			<p>
				Edit content, media, menus and site settings in EmDash. Use the content
				editor to preview and publish changes.
			</p>
			<p>
				For theme code, domains and deployments, open Sites in your Tedix
				workspace.
			</p>
			<a
				href="https://os.tedix.dev/sites"
				target="_blank"
				rel="noopener noreferrer"
			>
				Open Sites
			</a>
		</section>
	);
}

type DeliveryStatus = {
	pending: number;
	failed: number;
	receipts: Array<{
		id: string;
		recipient: string;
		status: string;
		attempts: number;
	}>;
};
const deliveryPlugins = [
	{ id: "tedix-tedi-bridge", label: "Memory sync" },
	{ id: "emdash-newsletter", label: "Newsletter" },
];
function deliveryUrl(plugin: string, action: string) {
	const prefix = window.location.pathname.split("/_emdash/")[0] ?? "";
	return `${prefix}/_emdash/api/plugins/${plugin}/deliveries/${action}`;
}
export function PublishDeliveries() {
	const [statuses, setStatuses] = useState<Record<string, DeliveryStatus>>({});
	const [error, setError] = useState("");
	async function refresh() {
		try {
			const values = await Promise.all(
				deliveryPlugins.map(async (plugin) => {
					const response = await apiFetch(deliveryUrl(plugin.id, "status"), {
						cache: "no-store",
					});
					if (!response.ok)
						throw new Error(
							"Delivery status unavailable. Administrator access is required.",
						);
					return [
						plugin.id,
						(await response.json()) as DeliveryStatus,
					] as const;
				}),
			);
			setStatuses(Object.fromEntries(values));
			setError("");
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Delivery status unavailable.",
			);
		}
	}
	useEffect(() => {
		void refresh();
	}, []);
	async function retry(plugin: string, id: string) {
		try {
			const response = await apiFetch(deliveryUrl(plugin, "retry"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id }),
			});
			if (!response.ok)
				throw new Error("Could not queue the retry. Refresh and try again.");
			await refresh();
		} catch (error) {
			setError(error instanceof Error ? error.message : "Retry unavailable.");
		}
	}
	return (
		<section aria-label="Publish deliveries">
			<h2>Publish deliveries</h2>
			<p>
				Publishing is independent of memory sync and newsletter delivery. Failed
				deliveries retry automatically up to eight times. Sent means the
				provider accepted the request.
			</p>
			{error && <p role="alert">{error}</p>}
			<button type="button" onClick={() => void refresh()}>
				Refresh deliveries
			</button>
			{deliveryPlugins.map((plugin) => (
				<div key={plugin.id}>
					<h3>{plugin.label}</h3>
					{statuses[plugin.id] ? (
						<>
							<p>
								{statuses[plugin.id]!.pending} pending ·{" "}
								{statuses[plugin.id]!.failed} failed
							</p>
							<ul>
								{statuses[plugin.id]!.receipts.filter(
									(receipt) => receipt.status === "failed",
								).map((receipt) => (
									<li key={receipt.id}>
										{receipt.recipient} · {receipt.attempts} attempts{" "}
										<button
											type="button"
											onClick={() => void retry(plugin.id, receipt.id)}
										>
											Retry delivery
										</button>
									</li>
								))}
							</ul>
						</>
					) : (
						<p>Loading delivery status…</p>
					)}
				</div>
			))}
			<p>
				For plain webhooks, use the upstream{" "}
				<a href="https://plugins.emdashcms.com/plugins/@plugins.emdashcms.com/webhook-notifier">
					Webhook Notifier
				</a>{" "}
				plugin.
			</p>
		</section>
	);
}

export const pages = {
	"/development": SiteDevelopmentPage,
} satisfies Record<string, ComponentType>;

// Search text is produced by the page-search hook; editors change the page blocks.
export function DerivedSearchText({ value }: { value: unknown }) {
	return (
		<details>
			<summary>Generated search text</summary>
			<p>
				This text is generated when page sections are saved. Edit the sections
				to update it.
			</p>
			<p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{typeof value === "string" && value ? value : "No search text yet."}
			</p>
		</details>
	);
}

export const fields = { "derived-search-text": DerivedSearchText };
