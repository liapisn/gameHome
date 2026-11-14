"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/app/actions";
import type { Property, PropertyKind } from "@/lib/admin/data";

const KINDS: { value: PropertyKind; label: string }[] = [
  { value: "apartment", label: "Apartment" },
  { value: "house", label: "House" },
  { value: "maisonette", label: "Maisonette" },
  { value: "studio", label: "Studio" },
  { value: "villa", label: "Villa" },
  { value: "other", label: "Other" },
];

const inputClass =
  "w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900";

export function PropertyForm({
  action,
  property,
  submitLabel,
  showFloors = false,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  property?: Partial<Property>;
  submitLabel: string;
  showFloors?: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  const err = state.fieldErrors ?? {};

  const field = (name: string, label: string, input: React.ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      {input}
      {err[name] ? (
        <p className="text-xs text-red-700">{err[name]}</p>
      ) : hint ? (
        <p className="text-xs text-neutral-500">{hint}</p>
      ) : null}
    </div>
  );

  const value = (v: unknown) => (v == null ? "" : String(v));

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-5">
      {field(
        "title",
        "Name",
        <input id="title" name="title" required defaultValue={value(property?.title)} className={inputClass} />,
        "Shown to viewers, e.g. “Sunny 2-bedroom in Koukaki”",
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        {field(
          "kind",
          "Type",
          <select id="kind" name="kind" defaultValue={property?.kind ?? "apartment"} className={inputClass}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>,
        )}
        {showFloors &&
          field(
            "floors",
            "Floors",
            <input id="floors" name="floors" type="number" min={1} max={10} defaultValue={1} className={inputClass} />,
            "You'll upload one floor plan per floor",
          )}
      </div>

      {field("address", "Street address", <input id="address" name="address" defaultValue={value(property?.address)} className={inputClass} />, "Kept private until you publish")}

      <div className="grid gap-5 sm:grid-cols-2">
        {field("area", "Neighbourhood", <input id="area" name="area" defaultValue={value(property?.area)} className={inputClass} placeholder="Koukaki" />)}
        {field("city", "City", <input id="city" name="city" defaultValue={value(property?.city)} className={inputClass} placeholder="Athens" />)}
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        {field("total_area_m2", "Size (m²)", <input id="total_area_m2" name="total_area_m2" inputMode="decimal" defaultValue={value(property?.total_area_m2)} className={inputClass} />)}
        {field("bedrooms", "Bedrooms", <input id="bedrooms" name="bedrooms" inputMode="numeric" defaultValue={value(property?.bedrooms)} className={inputClass} />)}
        {field("bathrooms", "Bathrooms", <input id="bathrooms" name="bathrooms" inputMode="numeric" defaultValue={value(property?.bathrooms)} className={inputClass} />)}
      </div>

      {field(
        "description",
        "Description",
        <textarea id="description" name="description" rows={4} defaultValue={value(property?.description)} className={inputClass} />,
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {state.saved && !pending && <span className="text-sm text-emerald-700">Saved</span>}
        {state.error && <span className="text-sm text-red-700">{state.error}</span>}
      </div>
    </form>
  );
}
