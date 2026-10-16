import { useState } from "react";

/**
 * An organization's square mark: its uploaded logo when one loads, otherwise
 * the letter tile. A logo URL that fails to load falls back to the letter
 * instead of leaving a broken image in the chrome.
 */
export function OrganizationMark({
	logoUrl,
	name,
	size = "default",
}: {
	logoUrl?: string | null;
	name: string;
	size?: "default" | "sm";
}) {
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const sizeAttribute = size === "sm" ? "sm" : undefined;

	if (logoUrl && failedUrl !== logoUrl) {
		const pixels = size === "sm" ? 20 : 24;
		return (
			<img
				alt=""
				className="brand-mark brand-mark-image"
				data-size={sizeAttribute}
				decoding="async"
				height={pixels}
				onError={() => setFailedUrl(logoUrl)}
				src={logoUrl}
				width={pixels}
			/>
		);
	}

	return (
		<span aria-hidden="true" className="brand-mark" data-size={sizeAttribute}>
			{name.trim().charAt(0).toUpperCase() || "T"}
		</span>
	);
}
