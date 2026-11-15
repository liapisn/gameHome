"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/app/actions";
import { importFromProsperty } from "@/app/app/import-actions";

/** Paste a Prosperty listing link to create the property with its details, photos and floor plan. */
export function ProspertyImport() {
  const [state, action, pending] = useActionState<FormState, FormData>(importFromProsperty, {});
  const error = state.fieldErrors?.url ?? state.error;

  return (
    <form action={action} className="flex max-w-2xl flex-col gap-2 rounded-xl border border-black/10 bg-neutral-50 p-4">
      <label htmlFor="prosperty-url" className="text-sm font-medium">
        Import from a Prosperty listing
      </label>
      <div className="flex gap-2">
        <input
          id="prosperty-url"
          name="url"
          type="url"
          required
          placeholder="https://theprosperty.com/listings/16042"
          disabled={pending}
          className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import"}
        </button>
      </div>
      {error ? (
        <p className="text-xs text-red-700">{error}</p>
      ) : (
        <p className="text-xs text-neutral-500">
          {pending
            ? "Copying details, photos and the floor plan. This takes up to a minute."
            : "Fills in the details and copies all photos and the floor plan."}
        </p>
      )}
    </form>
  );
}
