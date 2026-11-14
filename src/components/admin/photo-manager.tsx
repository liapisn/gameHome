"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import { preparePhoto } from "@/lib/image-resize";
import { MAX_PHOTOS_PER_PROPERTY, MEDIA_BUCKET, photoPath, thumbPathFor } from "@/lib/admin/media-paths";
import type { PropertyMedia } from "@/lib/admin/data";
import { ROOM_TYPES, type RoomType } from "@/lib/floorplan";
import { ROOM_TYPE_LABEL } from "./plan-rooms";
import { deletePhotos, recordPhotos, reorderPhotos, updatePhoto } from "@/app/app/properties/[id]/media-actions";
import { DropZone } from "./drop-zone";

type Photo = PropertyMedia["photos"][number];
type Level = PropertyMedia["levels"][number];

interface Upload {
  key: string;
  name: string;
  preview: string;
  status: "queued" | "preparing" | "uploading" | "done" | "error";
  error?: string;
}

const CONCURRENCY = 3;

export function PhotoManager({
  propertyId,
  orgId,
  photos: serverPhotos,
  levels,
}: {
  propertyId: string;
  orgId: string;
  photos: Photo[];
  levels: Level[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Local copy for optimistic reordering; reset whenever the server sends fresh data.
  const [photos, setPhotos] = useState(serverPhotos);
  const [prevServerPhotos, setPrevServerPhotos] = useState(serverPhotos);
  if (serverPhotos !== prevServerPhotos) {
    setPrevServerPhotos(serverPhotos);
    setPhotos(serverPhotos);
  }

  const [uploads, setUploads] = useState<Upload[]>([]);
  const queue = useRef<{ key: string; file: File }[]>([]);
  const active = useRef(0);
  // Uploads finish in any order; remember the order files were picked in and each one's media id.
  const batchOrder = useRef<string[]>([]);
  const mediaIds = useRef(new Map<string, string>());
  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  const patchUpload = (key: string, patch: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  const finishBatch = () => {
    const uploaded = batchOrder.current.flatMap((k) => mediaIds.current.get(k) ?? []);
    batchOrder.current = [];
    mediaIds.current.clear();
    startTransition(async () => {
      if (uploaded.length > 1) {
        // Server data refreshes after each recorded upload, so some new ids may already be listed.
        const fresh = new Set(uploaded);
        const existing = photosRef.current.map((p) => p.id).filter((id) => !fresh.has(id));
        try {
          await reorderPhotos(propertyId, [...existing, ...uploaded]);
        } catch {
          // Order is cosmetic; the photos themselves are saved. The user can drag to fix it.
        }
      }
      router.refresh();
      setUploads((list) => {
        for (const u of list) if (u.status === "done") URL.revokeObjectURL(u.preview);
        return list.filter((u) => u.status !== "done");
      });
    });
  };

  const uploadOne = async ({ key, file }: { key: string; file: File }) => {
    try {
      patchUpload(key, { status: "preparing" });
      const { full, thumb } = await preparePhoto(file);

      patchUpload(key, { status: "uploading" });
      const fileId = crypto.randomUUID();
      const path = photoPath(orgId, propertyId, fileId);
      const storage = createClient().storage.from(MEDIA_BUCKET);
      const [a, b] = await Promise.all([
        storage.upload(path, full.blob, { contentType: "image/webp" }),
        storage.upload(thumbPathFor(path), thumb.blob, { contentType: "image/webp" }),
      ]);
      const uploadError = a.error ?? b.error;
      if (uploadError) throw new Error(uploadError.message);

      const [recorded] = await recordPhotos(propertyId, [
        { fileId, width: full.width, height: full.height, bytes: full.blob.size },
      ]);
      mediaIds.current.set(key, recorded.id);
      patchUpload(key, { status: "done" });
    } catch (e) {
      patchUpload(key, { status: "error", error: e instanceof Error ? e.message : "Upload failed" });
    }
  };

  const pump = () => {
    while (active.current < CONCURRENCY && queue.current.length) {
      const job = queue.current.shift()!;
      active.current++;
      void uploadOne(job).finally(() => {
        active.current--;
        if (queue.current.length) pump();
        else if (active.current === 0) finishBatch();
      });
    }
  };

  const addFiles = (files: File[]) => {
    setError(null);
    const room = MAX_PHOTOS_PER_PROPERTY - photos.length - uploads.filter((u) => u.status !== "error").length;
    if (room <= 0) {
      setError(`A property can have at most ${MAX_PHOTOS_PER_PROPERTY} photos.`);
      return;
    }
    const accepted = files.slice(0, room);
    if (accepted.length < files.length) {
      setError(`Only the first ${accepted.length} photos were added: the limit is ${MAX_PHOTOS_PER_PROPERTY}.`);
    }
    const items = accepted.map((file) => ({ key: crypto.randomUUID(), file }));
    setUploads((list) => [
      ...list,
      ...items.map(({ key, file }) => ({ key, name: file.name, preview: URL.createObjectURL(file), status: "queued" as const })),
    ]);
    queue.current.push(...items);
    batchOrder.current.push(...items.map((i) => i.key));
    pump();
  };

  const act = (fn: () => Promise<void>, revert?: () => void) =>
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        revert?.();
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    if (!over || a.id === over.id) return;
    const before = photos;
    const next = arrayMove(photos, photos.findIndex((p) => p.id === a.id), photos.findIndex((p) => p.id === over.id));
    setPhotos(next);
    act(() => reorderPhotos(propertyId, next.map((p) => p.id)), () => setPhotos(before));
  };

  const busy = uploads.some((u) => u.status !== "done" && u.status !== "error");
  const failed = uploads.filter((u) => u.status === "error");

  return (
    <div>
      <DropZone
        multiple
        onFiles={addFiles}
        label="Drop photos here"
        sublabel={`or click to choose · JPEG, PNG, WebP · up to ${MAX_PHOTOS_PER_PROPERTY} photos`}
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="text-neutral-600">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
          {busy && ` · uploading ${uploads.filter((u) => u.status !== "done" && u.status !== "error").length}…`}
          {photos.length > 1 && " · drag ⠿ to reorder"}
        </p>
        {failed.length > 0 && (
          <button
            type="button"
            className="text-neutral-500 hover:text-neutral-900"
            onClick={() =>
              setUploads((list) => {
                for (const u of list) if (u.status === "error") URL.revokeObjectURL(u.preview);
                return list.filter((u) => u.status !== "error");
              })
            }
          >
            Clear {failed.length} failed
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={photos.map((p) => p.id)} strategy={rectSortingStrategy}>
          <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo, i) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                index={i}
                levels={levels}
                onLevel={(levelId) => {
                  setPhotos((list) => list.map((p) => (p.id === photo.id ? { ...p, levelId, roomId: null } : p)));
                  act(() => updatePhoto(propertyId, photo.id, { levelId }));
                }}
                onRoom={(levelId, roomId, roomType) => {
                  setPhotos((list) => list.map((p) => (p.id === photo.id ? { ...p, levelId, roomId, roomType } : p)));
                  act(() => updatePhoto(propertyId, photo.id, { levelId, roomId }));
                }}
                onHint={(hint) => act(() => updatePhoto(propertyId, photo.id, { hint }))}
                onRoomType={(roomType) => {
                  setPhotos((list) => list.map((p) => (p.id === photo.id ? { ...p, roomType, roomId: null } : p)));
                  act(() => updatePhoto(propertyId, photo.id, { roomType }));
                }}
                onDelete={() => {
                  const before = photos;
                  setPhotos((list) => list.filter((p) => p.id !== photo.id));
                  act(() => deletePhotos(propertyId, [photo.id]), () => setPhotos(before));
                }}
              />
            ))}
            {uploads.map((u) => (
              <UploadCard key={u.key} upload={u} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function PhotoCard({
  photo,
  index,
  levels,
  onLevel,
  onHint,
  onRoom,
  onRoomType,
  onDelete,
}: {
  photo: Photo;
  index: number;
  levels: Level[];
  onLevel: (levelId: string | null) => void;
  onHint: (hint: string) => void;
  onRoom: (levelId: string, roomId: string, roomType: RoomType) => void;
  onRoomType: (roomType: RoomType | null) => void;
  onDelete: () => void;
}) {
  // Rooms come from the stored plans: the photo's floor, or every floor with a plan when it has none.
  const roomLevels = levels.filter((l) => l.plan && (!photo.levelId || l.id === photo.levelId));
  const roomValue = photo.roomId && photo.levelId ? `room:${photo.levelId}:${photo.roomId}` : photo.roomType ? `type:${photo.roomType}` : "";
  const pickRoom = (value: string) => {
    if (value.startsWith("room:")) {
      const [, levelId, roomId] = value.split(":");
      const room = levels.find((l) => l.id === levelId)?.plan?.rooms.find((r) => r.id === roomId);
      if (room) onRoom(levelId, roomId, room.type);
    } else onRoomType(value ? (value.slice(5) as RoomType) : null);
  };

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: photo.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`overflow-hidden rounded-xl border border-black/10 bg-white ${isDragging ? "z-10 shadow-lg" : ""}`}
    >
      <div className="relative">
        <a href={photo.fullUrl ?? undefined} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL, pre-sized thumbnail */}
          <img
            src={photo.thumbUrl ?? undefined}
            alt={photo.hint || `Photo ${index + 1}`}
            loading="lazy"
            className="aspect-[4/3] w-full bg-neutral-100 object-cover"
          />
        </a>
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          type="button"
          aria-label={`Reorder photo ${index + 1}`}
          className="absolute top-2 left-2 cursor-grab rounded-md bg-white/90 px-1.5 py-0.5 text-sm shadow-sm active:cursor-grabbing"
        >
          ⠿
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete photo ${index + 1}`}
          className="absolute top-2 right-2 rounded-md bg-white/90 px-2 py-0.5 text-sm shadow-sm hover:text-red-700"
        >
          ×
        </button>
      </div>
      <div className="flex flex-col gap-1.5 p-2">
        <select
          aria-label="Floor"
          value={photo.levelId ?? ""}
          onChange={(e) => onLevel(e.target.value || null)}
          className="w-full rounded-md border border-black/10 bg-white px-2 py-1 text-xs"
        >
          <option value="">Floor: let the engine decide</option>
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Room"
          value={roomValue}
          onChange={(e) => pickRoom(e.target.value)}
          className="w-full rounded-md border border-black/10 bg-white px-2 py-1 text-xs"
        >
          <option value="">Room: let the engine decide</option>
          {roomLevels.map((l) =>
            roomLevels.length > 1 ? (
              <optgroup key={l.id} label={l.name}>
                {l.plan!.rooms.map((r) => (
                  <option key={r.id} value={`room:${l.id}:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ) : (
              l.plan!.rooms.map((r) => (
                <option key={r.id} value={`room:${l.id}:${r.id}`}>
                  {r.name}
                </option>
              ))
            ),
          )}
          <optgroup label={roomLevels.length ? "Kind of room only" : "Kind of room"}>
            {ROOM_TYPES.map((t) => (
              <option key={t} value={`type:${t}`}>
                {roomLevels.length ? `Some ${ROOM_TYPE_LABEL[t].toLowerCase()}` : ROOM_TYPE_LABEL[t]}
              </option>
            ))}
          </optgroup>
        </select>
        <input
          aria-label="Note"
          defaultValue={photo.hint}
          placeholder="Note (optional), e.g. view from the balcony"
          maxLength={120}
          onBlur={(e) => e.target.value.trim() !== photo.hint && onHint(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-full rounded-md border border-black/10 px-2 py-1 text-xs"
        />
      </div>
    </li>
  );
}


const STATUS_LABEL: Record<Upload["status"], string> = {
  queued: "Waiting…",
  preparing: "Resizing…",
  uploading: "Uploading…",
  done: "Uploaded",
  error: "Failed",
};

function UploadCard({ upload }: { upload: Upload }) {
  return (
    <li className="overflow-hidden rounded-xl border border-black/10 bg-white">
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
        <img src={upload.preview} alt="" className="aspect-[4/3] w-full bg-neutral-100 object-cover opacity-50" />
        <span
          className={`absolute inset-x-2 bottom-2 rounded-md px-2 py-1 text-xs font-medium ${
            upload.status === "error" ? "bg-red-50 text-red-800" : "bg-white/90 text-neutral-800"
          }`}
        >
          {STATUS_LABEL[upload.status]}
        </span>
      </div>
      <p className="truncate p-2 text-xs text-neutral-500" title={upload.error ?? upload.name}>
        {upload.error ?? upload.name}
      </p>
    </li>
  );
}
