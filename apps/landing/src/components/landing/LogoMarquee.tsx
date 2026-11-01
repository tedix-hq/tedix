import { Marquee } from "../magicui/Marquee";
import { cn } from "@/lib/utils";

export interface BrandLogo {
	src: string;
	alt: string;
	/** Preserve contrasting details inside an icon, such as the Photoshop mark. */
	preserveDetails?: boolean;
	/** Some official artwork includes a white background; keep its original colors. */
	lightSurface?: boolean;
}

export function LogoMarquee({ logos }: { logos: readonly BrandLogo[] }) {
	return (
		<Marquee
			data-logo-marquee
			pauseOnHover
			repeat={2}
			className="[--duration:35s] [--gap:2.5rem] py-3"
		>
			{logos.map((logo) => (
				<div
					key={logo.alt}
					className={cn(
						"flex h-14 w-32 shrink-0 items-center justify-center",
						logo.lightSurface && "rounded-lg bg-white px-3",
					)}
				>
					<img
						src={logo.src}
						alt={logo.alt}
						title={logo.alt}
						loading="lazy"
						className={cn(
							"h-8 w-auto max-w-28 object-contain",
							!logo.lightSurface &&
								(logo.preserveDetails
									? "dark:invert"
									: "brightness-0 dark:invert"),
						)}
					/>
				</div>
			))}
		</Marquee>
	);
}
