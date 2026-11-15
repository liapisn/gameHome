"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createWorkspace, switchWorkspace, type WorkspaceFormState } from "@/app/app/workspace-actions";
import type { Workspace } from "@/lib/admin/data";

const ROLE_LABEL: Record<Workspace["role"], string> = { owner: "Owner", editor: "Editor" };

/** Header dropdown: the active workspace, the others to switch to, settings, and "New workspace". */
export function WorkspaceSwitcher({
  current,
  workspaces,
  email,
}: {
  current: Workspace;
  workspaces: Workspace[];
  email: string | null;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [creating, setCreating] = useState(false);
  const [state, createAction, pending] = useActionState<WorkspaceFormState, FormData>(createWorkspace, {});

  // Close on outside click and Escape, like a menu.
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) {
        el.open = false;
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  const others = workspaces.filter((w) => w.id !== current.id);

  return (
    <details ref={ref} className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 [&::-webkit-details-marker]:hidden">
        <span className="max-w-[12rem] truncate font-medium">{current.name}</span>
        <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 text-neutral-500">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>

      <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-black/10 bg-white p-1.5 text-sm shadow-lg">
        {email && <p className="truncate px-2.5 pb-2 pt-1.5 text-xs text-neutral-500">{email}</p>}

        <p className="px-2.5 pt-1 text-xs font-medium uppercase tracking-wide text-neutral-400">Workspaces</p>
        <div className="mt-1 flex items-center justify-between gap-2 rounded-lg bg-black/[0.04] px-2.5 py-2">
          <span className="truncate font-medium">{current.name}</span>
          <span className="shrink-0 text-xs text-neutral-500">{ROLE_LABEL[current.role]}</span>
        </div>
        {others.map((w) => (
          <form key={w.id} action={switchWorkspace.bind(null, w.id)}>
            <button
              type="submit"
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-black/5"
            >
              <span className="truncate">{w.name}</span>
              <span className="shrink-0 text-xs text-neutral-500">{ROLE_LABEL[w.role]}</span>
            </button>
          </form>
        ))}

        <div className="my-1.5 border-t border-black/10" />

        {creating ? (
          <form action={createAction} className="flex flex-col gap-2 px-2.5 py-2">
            <label htmlFor="new-workspace-name" className="text-xs font-medium">
              New workspace name
            </label>
            <input
              id="new-workspace-name"
              name="name"
              required
              maxLength={80}
              autoFocus
              placeholder="e.g. Koukaki Rentals"
              className="w-full rounded-lg border border-black/15 px-2.5 py-1.5 outline-none focus:border-neutral-900"
            />
            {state.error && <p className="text-xs text-red-700">{state.error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="rounded-lg px-2.5 py-1.5 hover:bg-black/5">
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
              >
                {pending ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-black/5"
          >
            + New workspace
          </button>
        )}
        <Link
          href="/app/settings"
          onClick={() => ref.current && (ref.current.open = false)}
          className="block rounded-lg px-2.5 py-2 hover:bg-black/5"
        >
          {current.role === "owner" ? "Members & settings" : "Members"}
        </Link>
      </div>
    </details>
  );
}
