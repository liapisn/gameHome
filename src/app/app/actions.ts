"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { defaultLevelName, requireSession } from "@/lib/admin/data";

export type FormState = { error?: string; fieldErrors?: Record<string, string>; saved?: boolean };

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v));

const optionalNumber = (max: number, integer = false) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      const n = Number(v.replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
        ctx.addIssue({ code: "custom", message: integer ? `Whole number up to ${max}` : `Number up to ${max}` });
        return z.NEVER;
      }
      return n;
    });

const PropertySchema = z.object({
  title: z.string().trim().min(1, "Give the property a name").max(120),
  kind: z.enum(["apartment", "house", "studio", "maisonette", "villa", "other"]),
  address: optionalText,
  city: optionalText,
  area: optionalText,
  total_area_m2: optionalNumber(10000),
  bedrooms: optionalNumber(50, true),
  bathrooms: optionalNumber(50, true),
  description: optionalText,
});

function readForm(formData: FormData) {
  const raw = Object.fromEntries(
    ["title", "kind", "address", "city", "area", "total_area_m2", "bedrooms", "bathrooms", "description"].map(
      (k) => [k, String(formData.get(k) ?? "")],
    ),
  );
  return PropertySchema.safeParse(raw);
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export async function createProperty(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = readForm(formData);
  const floors = Math.min(10, Math.max(1, Number(formData.get("floors") ?? 1) || 1));
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const { supabase, org } = await requireSession();
  const { data: property, error } = await supabase
    .from("properties")
    .insert({ ...parsed.data, org_id: org.id })
    .select("id")
    .single();
  if (error) return { error: error.message };

  const { error: levelsError } = await supabase.from("levels").insert(
    Array.from({ length: floors }, (_, i) => ({ property_id: property.id, name: defaultLevelName(i), sort: i })),
  );
  if (levelsError) return { error: levelsError.message };

  revalidatePath("/app");
  redirect(`/app/properties/${property.id}`);
}

export async function updateProperty(id: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = readForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.from("properties").update(parsed.data).eq("id", id);
  if (error) return { error: error.message };

  revalidatePath("/app");
  revalidatePath(`/app/properties/${id}`);
  return { saved: true };
}

export async function deleteProperty(id: string) {
  const supabase = await createClient();
  // Uploaded files are removed with the property once uploads land (phase 2).
  const { error } = await supabase.from("properties").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/app");
  redirect("/app");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
