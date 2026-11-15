"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import type { JobProgress } from "@/lib/admin/generate";
import { queueTourBuild } from "@/app/app/properties/[id]/generate/actions";

type JobRow = Pick<
  Database["public"]["Tables"]["jobs"]["Row"],
  "id" | "status" | "progress" | "error" | "created_at" | "started_at" | "finished_at"
>;

const STEPS: Record<NonNullable<JobProgress["step"]>, string> = {
  plans: "Reading floor plans",
  photos: "Placing photos",
  poses: "Solving camera positions",
  furnish: "Furnishing rooms from photos",
  done: "Finishing",
};

export function GeneratePanel({
  propertyId,
  floors,
  photos,
  minPhotos,
  initialJobs,
}: {
  propertyId: string;
  floors: { id: string; name: string; hasPlan: boolean }[];
  photos: number;
  minPhotos: number;
  initialJobs: JobRow[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Live job updates. Realtime respects RLS, so members only receive their own property's jobs.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`jobs:${propertyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "jobs", filter: `property_id=eq.${propertyId}` },
        (payload) => {
          const row = payload.new as JobRow;
          if (!row?.id || (payload.new as { type?: string }).type !== "build_tour") return; // plan reads are shown on the floor plans page
          setJobs((prev) => {
            const rest = prev.filter((j) => j.id !== row.id);
            return [row, ...rest].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10);
          });
          // Status changes move the property badge and the Tour tab: refresh server data.
          if (payload.eventType === "UPDATE" && (row.status === "succeeded" || row.status === "failed")) router.refresh();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [propertyId, router]);

  const planned = floors.filter((f) => f.hasPlan);
  const unplanned = floors.filter((f) => !f.hasPlan);
  const ready = planned.length > 0 && photos >= minPhotos;
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  const latest = jobs[0];

  const generate = () =>
    startTransition(async () => {
      setError(null);
      const res = await queueTourBuild(propertyId);
      if (res.error) setError(res.error);
      else router.refresh();
    });

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
      <section>
        <h2 className="text-base font-semibold">Before you generate</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <Check ok={planned.length > 0} href={`/app/properties/${propertyId}/floorplans`}>
            {planned.length
              ? `Floor plans for ${planned.map((f) => f.name).join(", ")}`
              : "Upload a floor plan for at least one floor"}
          </Check>
          {unplanned.length > 0 && planned.length > 0 && (
            <li className="pl-7 text-xs text-neutral-500">
              No plan for {unplanned.map((f) => f.name).join(", ")}: photos taken there are shown in a gallery instead of the 3D tour.
            </li>
          )}
          <Check ok={photos >= minPhotos} href={`/app/properties/${propertyId}/photos`}>
            {photos} photo{photos === 1 ? "" : "s"}
            {photos < minPhotos ? ` (at least ${minPhotos})` : ""}
          </Check>
        </ul>

        <button
          type="button"
          onClick={generate}
          disabled={!ready || !!active || pending}
          className="mt-6 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Queuing…" : latest?.status === "succeeded" ? "Generate again" : "Generate tour"}
        </button>
        {error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {error}
          </p>
        )}
        <p className="mt-4 max-w-md text-xs leading-relaxed text-neutral-500">
          Builds read the floor plans, place every photo and solve where each one was taken. Expect a few minutes
          for a typical home. A new build becomes the current tour when it finishes; earlier versions are kept.
        </p>
      </section>

      <section>
        {latest ? <JobCard job={latest} propertyId={propertyId} onRetry={generate} retrying={pending} /> : (
          <div className="rounded-2xl border border-dashed border-black/15 p-6 text-sm text-neutral-500">
            No builds yet.
          </div>
        )}
        {jobs.length > 1 && <History jobs={jobs.slice(1)} />}
      </section>
    </div>
  );
}

function Check({ ok, href, children }: { ok: boolean; href: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] ${
          ok ? "bg-emerald-100 text-emerald-800" : "bg-neutral-100 text-neutral-500"
        }`}
      >
        {ok ? "✓" : "·"}
      </span>
      {ok ? <span>{children}</span> : <Link href={href} className="underline underline-offset-2 hover:text-neutral-900">{children}</Link>}
    </li>
  );
}

function JobCard({ job, propertyId, onRetry, retrying }: { job: JobRow; propertyId: string; onRetry: () => void; retrying: boolean }) {
  const progress = (job.progress ?? {}) as JobProgress;
  const pct = progress.total ? Math.round((100 * (progress.done ?? 0)) / progress.total) : 0;
  const elapsed = useElapsed(job.status === "running" ? job.started_at : null);

  return (
    <div className="rounded-2xl border border-black/10 bg-white/70 p-5" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Latest build</h2>
        <JobStatus status={job.status} />
      </div>

      {job.status === "queued" && (
        <p className="mt-3 text-sm text-neutral-600">
          Waiting for the worker. It runs on a developer machine for now: start it with{" "}
          <code className="rounded bg-black/5 px-1.5 py-0.5 text-xs">npm run worker</code>.
        </p>
      )}

      {job.status === "running" && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-sm">
            <span>{progress.label ?? (progress.step ? STEPS[progress.step] : "Starting")}</span>
            <span className="tabular-nums text-neutral-500">
              {progress.total ? `${progress.done ?? 0} / ${progress.total}` : ""} {elapsed && `· ${elapsed}`}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/5">
            <div className="h-full rounded-full bg-[#c8643b] transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {job.status === "failed" && (
        <div className="mt-3">
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{job.error ?? "The build failed."}</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="mt-3 rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}

      {job.status === "succeeded" && (
        <p className="mt-3 text-sm text-neutral-600">
          Finished {job.finished_at ? new Date(job.finished_at).toLocaleString() : ""}
          {duration(job) && ` in ${duration(job)}`}.{" "}
          <Link href={`/app/properties/${propertyId}/tour`} className="font-medium text-[#c8643b] hover:underline">
            Open the tour →
          </Link>
        </p>
      )}
    </div>
  );
}

function History({ jobs }: { jobs: JobRow[] }) {
  return (
    <div className="mt-6">
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">Earlier builds</h3>
      <ul className="mt-2 divide-y divide-black/5 text-sm">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-3 py-2">
            <span className="text-neutral-600">{new Date(j.created_at).toLocaleString()}</span>
            <span className="flex items-center gap-3">
              {duration(j) && <span className="tabular-nums text-neutral-500">{duration(j)}</span>}
              <JobStatus status={j.status} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobStatus({ status }: { status: JobRow["status"] }) {
  const styles: Record<JobRow["status"], string> = {
    queued: "bg-neutral-100 text-neutral-700",
    running: "bg-amber-100 text-amber-800",
    succeeded: "bg-emerald-100 text-emerald-800",
    failed: "bg-red-100 text-red-800",
  };
  const labels: Record<JobRow["status"], string> = { queued: "Queued", running: "Running", succeeded: "Done", failed: "Failed" };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}>{labels[status]}</span>;
}

function duration(j: JobRow): string | null {
  if (!j.started_at || !j.finished_at) return null;
  return formatSeconds((Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000);
}

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  return m ? `${m} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
}

/** Ticking "3 min 12 s" since a timestamp, for running jobs. */
function useElapsed(since: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return useMemo(() => (since ? formatSeconds(Math.max(0, (now - Date.parse(since)) / 1000)) : null), [since, now]);
}
