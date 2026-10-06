/**
 * The Tedix astronaut mark for account, login, and interstitial surfaces.
 * Decorative beside a heading, so it stays hidden from assistive tech.
 */
export function TedixBrandMark({ size = 40 }: { size?: number }) {
	return (
		<img
			className="brand-logo"
			src="/images/tedi-astronaut-waving.png"
			alt=""
			aria-hidden="true"
			width={size}
			height={size}
		/>
	);
}

/** Horizontal Tedix lockup for primary identity and account entry surfaces. */
export function TedixBrandLogo({ size = 44 }: { size?: number }) {
	return (
		<div className="brand-lockup" role="img" aria-label="Tedix">
			<img
				className="brand-logo"
				src="/images/tedi-astronaut-waving.png"
				alt=""
				aria-hidden="true"
				width={size}
				height={size}
			/>
			<span className="brand-wordmark" aria-hidden="true">
				tedix
			</span>
		</div>
	);
}
