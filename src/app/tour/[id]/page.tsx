import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TourViewer } from "@/components/tour/TourViewer";
import { listPlanIds } from "@/lib/plans";
import { listTourIds, resolveTour } from "@/lib/tours";

export function generateStaticParams() {
  return [...new Set([...listTourIds(), ...listPlanIds()])].map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps<"/tour/[id]">): Promise<Metadata> {
  const tour = resolveTour((await params).id);
  return {
    title: tour ? `${tour.title} · gameHome` : "Tour · gameHome",
    description: "A walkable 3D tour generated from the floor plan and photos.",
  };
}

export default function TourPage({ params }: PageProps<"/tour/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-[#f3efe8] text-sm text-neutral-500">
          Loading tour…
        </div>
      }
    >
      <Tour params={params} />
    </Suspense>
  );
}

async function Tour({ params }: { params: PageProps<"/tour/[id]">["params"] }) {
  const tour = resolveTour((await params).id);
  if (!tour) notFound();
  return <TourViewer tour={tour} />;
}
