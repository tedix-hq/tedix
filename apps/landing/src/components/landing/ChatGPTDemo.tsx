"use client";

import { ComparisonLayout } from "@tedix/widget-ui/layouts";
import type { LayoutItem } from "@tedix/widget-ui/layouts";

const DEMO_RESULTS: LayoutItem[] = [
	{
		id: "1",
		title: "WOLTU Ergonomischer Gaming Stuhl",
		subtitle: "mit Verstellbarer Lordosenstutze",
		image: "/images/demo/chair-gaming.jpg",
		url: "#",
		price: { amount: 127.99, currency: "EUR" },
		rating: { value: 4.3, count: 1284 },
		seller: { name: "Amazon" },
		offerCount: 2,
		stock: { status: "in_stock" as const },
		shipping: { free: true, maxDays: 3 },
	},
	{
		id: "2",
		title: "SIHOO Ergonomisch Verstellbare Burostuhl",
		subtitle: "Lordosenstutze Burostuhl",
		image: "/images/demo/chair-ergonomic.jpg",
		url: "#",
		price: { amount: 213.99, currency: "EUR" },
		rating: { value: 4.5, count: 892 },
		seller: { name: "Otto" },
		offerCount: 2,
		stock: { status: "in_stock" as const },
		shipping: { free: true, maxDays: 5 },
	},
	{
		id: "3",
		title: "Ergotopia NextBack Ergonomischer Burostuhl",
		subtitle: "Adaptive Ruckenlehne",
		image: "/images/demo/chair-mesh.jpg",
		url: "#",
		price: { amount: 349.0, currency: "EUR" },
		rating: { value: 4.7, count: 456 },
		seller: { name: "Ergotopia" },
		offerCount: 1,
		stock: { status: "in_stock" as const },
		shipping: { free: true, maxDays: 2 },
	},
	{
		id: "4",
		title: "Herman Miller Aeron Remastered",
		subtitle: "Graphite / Size B",
		image: "/images/demo/chair-premium.jpg",
		url: "#",
		price: { amount: 1459.0, currency: "EUR" },
		rating: { value: 4.8, count: 3201 },
		seller: { name: "Design Bestseller" },
		offerCount: 4,
		stock: { status: "in_stock" as const },
		shipping: { free: true, maxDays: 7 },
	},
];

export function ChatGPTDemo({ className }: { className?: string }) {
	return (
		<div className={className}>
			{/* ChatGPT Chrome */}
			<div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#212121] shadow-2xl">
				{/* Header */}
				<div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						className="text-white/70"
					>
						<circle
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="1.5"
						/>
					</svg>
					<span className="text-sm font-semibold text-white/80">ChatGPT</span>
					<span className="ml-auto text-white/30 text-xs">4o</span>
				</div>

				{/* Chat content */}
				<div className="space-y-4 p-5">
					{/* User message */}
					<div className="flex justify-end">
						<div className="rounded-2xl bg-[#2f2f2f] px-4 py-2.5 text-sm text-white/80 max-w-[85%]">
							Find me a home office set up for 1000 euros on @Klarna
						</div>
					</div>

					{/* Klarna response header */}
					<div className="flex items-center gap-2">
						<div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FFB3C7]">
							<span className="text-[10px] font-bold text-black">K</span>
						</div>
						<span className="text-sm font-medium text-white/70">Klarna</span>
					</div>

					{/* Interactive widget — the real ComparisonLayout */}
					<div className="pointer-events-auto rounded-xl border border-white/[0.06] bg-[#1a1a1a] overflow-hidden">
						<ComparisonLayout
							results={DEMO_RESULTS}
							query="home office setup 1000 euros"
							currency="EUR"
							locale="de-DE"
							vertical="ecommerce"
							allowFullscreen={false}
							hideFilters
							displayMode="inline"
						/>
					</div>
				</div>

				{/* Input bar */}
				<div className="border-t border-white/[0.06] px-5 py-3">
					<div className="flex items-center gap-2 rounded-xl bg-[#2f2f2f] px-4 py-2.5">
						<span className="text-sm text-white/30">Ask anything</span>
						<div className="ml-auto flex items-center gap-2">
							<div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FFB3C7]/20">
								<span className="text-[8px] font-bold text-[#FFB3C7]">K</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
