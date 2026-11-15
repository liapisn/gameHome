"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ImportPlan,
  importMatterportPhotos,
  importMatterportPlans,
  importProspertyFloorplans,
  importProspertyPhotos,
  startProspertyImport,
  startTourEstimates,
} from "@/app/app/import-actions";

/** Photos per server call; matches the cap in importProspertyPhotos. */
const PHOTO_BATCH = 4;

type StepKey = "listing" | "photos" | "floorplan" | "tourPhotos" | "open";
type StepState = "waiting" | "active" | "done" | "skipped";

type Progress = {
  plan?: ImportPlan;
  steps: Record<StepKey, StepState>;
  photosDone: number;
  photosFailed: number;
  tourRooms: number;
  tourDone: number;
  tourFailed: number;
  error?: string;
};

const INITIAL: Progress = {
  steps: { listing: "waiting", photos: "waiting", floorplan: "waiting", tourPhotos: "waiting", open: "waiting" },
  photosDone: 0,
  photosFailed: 0,
  tourRooms: 0,
  tourDone: 0,
  tourFailed: 0,
};

/** Paste a Prosperty listing link to create the property with its details, photos and floor plan. */
export function ProspertyImport() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const running = progress != null && !progress.error && progress.steps.open !== "done";

  // Leaving mid-import keeps what was copied so far; warn before that happens by accident.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  async function run() {
    let p: Progress = { ...INITIAL, steps: { ...INITIAL.steps, listing: "active" } };
    const set = (patch: Partial<Progress> | ((p: Progress) => Partial<Progress>)) => {
      p = { ...p, ...(typeof patch === "function" ? patch(p) : patch) };
      setProgress(p);
    };
    const step = (key: StepKey, state: StepState) => set((cur) => ({ steps: { ...cur.steps, [key]: state } }));
    setProgress(p);

    const started = await startProspertyImport(url);
    if (!started.ok) return set({ error: started.error });
    const plan = started.value;
    set({ plan });
    step("listing", "done");

    if (plan.photoUrls.length) {
      step("photos", "active");
      for (let i = 0; i < plan.photoUrls.length; i += PHOTO_BATCH) {
        const batch = await importProspertyPhotos(
          plan.propertyId,
          plan.photoUrls.slice(i, i + PHOTO_BATCH),
          i, // listing position, so a failed photo leaves a gap rather than a clash
        );
        if (!batch.ok) return set({ error: batch.error });
        set((cur) => ({
          photosDone: cur.photosDone + batch.value.saved,
          photosFailed: cur.photosFailed + batch.value.failed,
        }));
      }
      step("photos", "done");
    } else step("photos", "skipped");

    if (plan.tour) {
      const { modelId, photoCount } = plan.tour;
      step("floorplan", "active");
      const plans = await importMatterportPlans(plan.propertyId, modelId);
      if (!plans.ok) return set({ error: plans.error });
      set({ tourRooms: plans.value.rooms });
      step("floorplan", "done");

      if (photoCount) {
        step("tourPhotos", "active");
        for (let i = 0; i < photoCount; i += PHOTO_BATCH) {
          const batch = await importMatterportPhotos(plan.propertyId, modelId, i, plan.photoUrls.length + i);
          if (!batch.ok) return set({ error: batch.error });
          set((cur) => ({ tourDone: cur.tourDone + batch.value.saved, tourFailed: cur.tourFailed + batch.value.failed }));
        }
        step("tourPhotos", "done");
      } else step("tourPhotos", "skipped");
      // Only the listing's own photos need their rooms guessing; a failure here leaves them to the photos page.
      if (plan.photoUrls.length) await startTourEstimates(plan.propertyId);
    } else {
      step("tourPhotos", "skipped");
      if (plan.floorplanUrls.length) {
        step("floorplan", "active");
        const plans = await importProspertyFloorplans(plan.propertyId, plan.floorplanUrls);
        if (!plans.ok) return set({ error: plans.error });
        step("floorplan", "done");
      } else step("floorplan", "skipped");
    }

    step("open", "active");
    router.push(`/app/properties/${plan.propertyId}`);
  }

  if (!progress) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="flex max-w-2xl flex-col gap-2 rounded-xl border border-black/10 bg-neutral-50 p-4"
      >
        <label htmlFor="prosperty-url" className="text-sm font-medium">
          Import from a Prosperty listing
        </label>
        <div className="flex gap-2">
          <input
            id="prosperty-url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://theprosperty.com/listings/16042"
            className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900"
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Import
          </button>
        </div>
        <p className="text-xs text-neutral-500">
          Fills in the details, copies all photos and the floor plan, then reads the plan&apos;s rooms and matches
          each photo to its room. A listing with a 3D tour gets its measured rooms and 360° photos from the tour.
        </p>
      </form>
    );
  }

  const { plan, steps, photosDone, photosFailed, tourRooms, tourDone, tourFailed, error } = progress;
  const tourTotal = plan?.tour?.photoCount ?? 0;
  const photoTotal = plan?.photoUrls.length ?? 0;
  const photosHandled = photosDone + photosFailed;

  return (
    <div className="flex max-w-2xl flex-col gap-4 rounded-xl border border-black/10 bg-neutral-50 p-4" aria-live="polite">
      <div>
        <p className="text-sm font-medium">{plan ? plan.title : "Importing from Prosperty"}</p>
        <p className="mt-0.5 text-xs text-neutral-500">{plan ? plan.summary : url}</p>
      </div>

      <ol className="flex flex-col gap-3">
        <Step state={steps.listing} label="Reading the listing" doneLabel="Property created" />
        <Step
          state={steps.photos}
          label={
            steps.photos === "skipped"
              ? "No photos on the listing"
              : photoTotal
                ? `Copying photos · ${photosHandled} of ${photoTotal}`
                : "Copying photos"
          }
          doneLabel={`${photosDone} photo${photosDone === 1 ? "" : "s"} copied${photosFailed ? ` · ${photosFailed} failed` : ""}`}
        >
          {steps.photos === "active" && photoTotal > 0 && <Bar value={photosHandled / photoTotal} />}
        </Step>
        {plan?.tour ? (
          <>
            <Step
              state={steps.floorplan}
              label="Reading the 3D tour"
              doneLabel={`${tourRooms} measured room${tourRooms === 1 ? "" : "s"} from the 3D tour`}
            />
            <Step
              state={steps.tourPhotos}
              label={steps.tourPhotos === "skipped" ? "No panoramas in the tour" : `Copying 360° views · ${tourDone + tourFailed} of ${tourTotal}`}
              doneLabel={`${tourDone} view${tourDone === 1 ? "" : "s"} copied, each filed under its room${tourFailed ? ` · ${tourFailed} failed` : ""}${photosDone ? " · matching the listing photos to rooms in the background" : ""}`}
            >
              {steps.tourPhotos === "active" && tourTotal > 0 && <Bar value={(tourDone + tourFailed) / tourTotal} />}
            </Step>
          </>
        ) : (
          <Step
            state={steps.floorplan}
            label={steps.floorplan === "skipped" ? "No floor plan on the listing" : "Copying the floor plan"}
            doneLabel={`Floor plan${(plan?.floorplanUrls.length ?? 0) > 1 ? "s" : ""} copied · reading rooms, then matching each photo to its room, in the background`}
          />
        )}
        <Step state={steps.open} label="Opening the property" doneLabel="Opening the property" />
      </ol>

      {error ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-black/10 pt-3 text-sm">
          <span className="text-red-700">{error}</span>
          {plan && (
            <Link href={`/app/properties/${plan.propertyId}`} className="font-medium underline">
              Open what was imported
            </Link>
          )}
          <button type="button" onClick={() => setProgress(null)} className="text-neutral-600 underline">
            Start over
          </button>
        </div>
      ) : (
        <p className="text-xs text-neutral-500">Takes a minute or two. Keep this page open.</p>
      )}
    </div>
  );
}

function Step({
  state,
  label,
  doneLabel,
  children,
}: {
  state: StepState;
  label: string;
  doneLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {state === "done" ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-emerald-600" aria-hidden>
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : state === "active" ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
        ) : (
          <span className={`h-2 w-2 rounded-full ${state === "skipped" ? "bg-neutral-200" : "bg-neutral-300"}`} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span
          className={`text-sm ${state === "waiting" || state === "skipped" ? "text-neutral-400" : "text-neutral-900"}`}
        >
          {state === "done" ? doneLabel : label}
        </span>
        {children}
      </div>
    </li>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
      <div
        className="h-full rounded-full bg-neutral-900 transition-[width] duration-500"
        style={{ width: `${Math.round(Math.max(0.03, value) * 100)}%` }}
      />
    </div>
  );
}
