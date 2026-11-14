import type { Metadata } from "next";
import { TourViewer } from "@/components/tour/TourViewer";
import { demoPlan } from "@/lib/floorplan";

export const metadata: Metadata = {
  title: "Demo tour · gameHome",
  description: "A 3D dollhouse tour generated from structured floor plan geometry.",
};

export default function DemoTourPage() {
  return <TourViewer plan={demoPlan} />;
}
