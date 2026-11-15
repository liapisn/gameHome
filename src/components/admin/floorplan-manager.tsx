"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { prepareFloorplan } from "@/lib/image-resize";
import { MEDIA_BUCKET, floorplanPath } from "@/lib/admin/media-paths";
import type { PropertyMedia } from "@/lib/admin/data";
import {
  addLevel,
  deleteLevel,
  readFloorplan,
  removeFloorplan,
  renameLevel,
  setFloorplan,
  updatePlanRoom,
} from "@/app/app/properties/[id]/media-actions";
import type { RoomType } from "@/lib/floorplan";
import { DropZone } from "./drop-zone";
import { PlanRooms } from "./plan-rooms";

type Level = PropertyMedia["levels"][number];

export function FloorplanManager({ propertyId, orgId, levels }: { propertyId: string; orgId: string; levels: Level[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Plans are read in the background: refresh while any floor is being read.
  const reading = levels.some((l) => l.read?.status === "reading");
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [reading, router]);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };

  return (
    <div>
      <p className="max-w-2xl text-sm text-neutral-600">
        Upload one floor plan per floor: a scan, a photo of the paper plan, or an export from the architect. Plans
        with printed room dimensions give the most accurate 3D model. Each plan is read into rooms; check them
        and fix any name or kind of room that came out wrong, since photos are matched to these rooms.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {levels.map((level) => (
          <LevelCard
            key={level.id}
            level={level}
            canDelete={levels.length > 1}
            onRename={(name) => run(() => renameLevel(propertyId, level.id, name))}
            onDelete={() => {
              if (confirm(`Delete “${level.name}” and its floor plan? Photos assigned to it stay.`))
                run(() => deleteLevel(propertyId, level.id));
            }}
            onRemovePlan={() => run(() => removeFloorplan(propertyId, level.id))}
            onRead={async () => {
              await readFloorplan(propertyId, level.id);
              router.refresh();
            }}
            onRenameRoom={(roomId, name) => run(() => updatePlanRoom(propertyId, level.id, roomId, { name }))}
            onRetype={(roomId, type) => run(() => updatePlanRoom(propertyId, level.id, roomId, { type }))}
            onUpload={async (file) => {
              const prepared = await prepareFloorplan(file);
              const fileId = crypto.randomUUID();
              const { error: uploadError } = await createClient()
                .storage.from(MEDIA_BUCKET)
                .upload(floorplanPath(orgId, propertyId, fileId), prepared.blob, { contentType: "image/webp" });
              if (uploadError) throw new Error(uploadError.message);
              await setFloorplan(propertyId, level.id, {
                fileId,
                width: prepared.width,
                height: prepared.height,
                bytes: prepared.blob.size,
              });
              router.refresh();
            }}
            readOnUpload
          />
        ))}
      </div>

      <button
        type="button"
        disabled={pending || levels.length >= 10}
        onClick={() => run(() => addLevel(propertyId))}
        className="mt-6 rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 disabled:opacity-60"
      >
        Add floor
      </button>
    </div>
  );
}

function LevelCard({
  level,
  canDelete,
  onRename,
  onDelete,
  onRemovePlan,
  onUpload,
  onRead,
  onRenameRoom,
  onRetype,
  readOnUpload,
}: {
  level: Level;
  canDelete: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRemovePlan: () => void;
  onUpload: (file: File) => Promise<void>;
  onRead: () => Promise<void>;
  onRenameRoom: (roomId: string, name: string) => void;
  onRetype: (roomId: string, type: RoomType) => void;
  readOnUpload?: boolean;
}) {
  const [local, setStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  // A read started here counts as "starting" until the page shows its job (or the new plan): the
  // refreshed page may still show no job, or the previous one, for a moment.
  const [startedFrom, setStartedFrom] = useState<{ job: string | null; plan: string | null } | null>(null);
  const jobSince = level.read?.since ?? null;
  const planAt = level.plan?.source?.parsedAt ?? null;
  const starting = !!startedFrom && planAt === startedFrom.plan && (jobSince === null || jobSince === startedFrom.job);
  const status = starting || (local !== "uploading" && level.read?.status === "reading") ? "reading" : local;
  const failed = local !== "error" && !starting && level.read?.status === "failed" ? level.read.error : null;

  const read = async () => {
    setStartedFrom({ job: jobSince, plan: planAt });
    setStatus("idle");
    setMessage(null);
    try {
      await onRead();
    } catch (e) {
      setStartedFrom(null);
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Could not read the floor plan");
    }
  };

  const upload = async (file: File) => {
    setStatus("uploading");
    setMessage(null);
    try {
      await onUpload(file);
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "Upload failed");
      return;
    }
    if (readOnUpload) await read();
    else setStatus("idle");
  };

  return (
    <div className="rounded-2xl border border-black/10 bg-white/70 p-4">
      <div className="flex items-center gap-2">
        <input
          defaultValue={level.name}
          aria-label="Floor name"
          maxLength={60}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== level.name) onRename(name);
            else e.target.value = level.name;
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-semibold hover:border-black/10 focus:border-neutral-900 focus:outline-none"
        />
        {canDelete && (
          <button type="button" onClick={onDelete} className="text-xs text-neutral-500 hover:text-red-700">
            Delete floor
          </button>
        )}
      </div>

      <div className="mt-3">
        {level.floorplanUrl && status !== "uploading" ? (
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL, already resized */}
            <img
              src={level.floorplanUrl}
              alt={`Floor plan: ${level.name}`}
              className="aspect-[4/3] w-full rounded-lg border border-black/10 bg-white object-contain"
            />
            <div className="mt-3 flex gap-2">
              <DropZone
                onFiles={([f]) => upload(f)}
                label="Replace plan"
                className="flex-1 !flex-row !py-2"
              />
              <button
                type="button"
                onClick={onRemovePlan}
                className="rounded-xl border border-black/15 px-3 text-sm hover:bg-black/5"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <DropZone
            onFiles={([f]) => upload(f)}
            disabled={status === "uploading"}
            label={status === "uploading" ? "Uploading…" : "Drop the floor plan here"}
            sublabel={status === "uploading" ? undefined : "or click to choose · JPEG, PNG, WebP"}
            className="aspect-[4/3]"
          />
        )}
        {(message ?? failed) && <p className="mt-2 text-xs text-red-700">{message ?? `Reading the rooms failed: ${failed}`}</p>}
      </div>

      {level.floorplanUrl && status !== "uploading" && (
        <div className="mt-4 grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              {status === "reading"
                ? "Reading rooms…"
                : level.plan
                  ? `${level.plan.rooms.length} rooms read from the plan`
                  : "Rooms not read yet"}
            </h3>
            <button
              type="button"
              onClick={() => {
                if (
                  !level.plan ||
                  confirm("Read the plan again? Room names you fixed are replaced, and photos tagged with a room on this floor lose that tag.")
                )
                  void read();
              }}
              disabled={status === "reading"}
              className="rounded-lg border border-black/15 px-3 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-60"
            >
              {level.plan ? "Read again" : "Read rooms"}
            </button>
          </div>
          {status === "reading" ? (
            <p className="text-xs text-neutral-500">
              This can take several minutes. It carries on in the background: you can leave this page and come back.
            </p>
          ) : level.plan ? (
            <PlanRooms plan={level.plan} onRename={onRenameRoom} onRetype={onRetype} />
          ) : (
            <p className="text-xs text-neutral-500">
              Read the plan to see its rooms. Photos can then be matched to them, and every tour build uses the same rooms.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
