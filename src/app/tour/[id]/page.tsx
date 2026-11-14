import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TourViewer } from "@/components/tour/TourViewer";
import { getPlan, listPlanIds } from "@/lib/plans";

export function generateStaticParams() {
  return listPlanIds().map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps<"/tour/[id]">): Promise<Metadata> {
  const plan = getPlan((await params).id);
  return {
    title: plan ? `${plan.title} · gameHome` : "Tour · gameHome",
    description: "A 3D dollhouse tour generated from structured floor plan geometry.",
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
  const plan = getPlan((await params).id);
  if (!plan) notFound();
  return <TourViewer plan={plan} />;
}
