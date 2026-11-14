import "server-only";
import { redirect } from "next/navigation";
import { createClient, getUser } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export type Property = Database["public"]["Tables"]["properties"]["Row"];
export type Level = Database["public"]["Tables"]["levels"]["Row"];
export type PropertyKind = Database["public"]["Enums"]["property_kind"];
export type PropertyStatus = Database["public"]["Enums"]["property_status"];

export const PROPERTY_KINDS: { value: PropertyKind; label: string }[] = [
  { value: "apartment", label: "Apartment" },
  { value: "house", label: "House" },
  { value: "maisonette", label: "Maisonette" },
  { value: "studio", label: "Studio" },
  { value: "villa", label: "Villa" },
  { value: "other", label: "Other" },
];

/** Signed-in user + their organization. Redirects to /login when signed out. */
export async function requireSession() {
  const user = await getUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: membership } = await supabase
    .from("memberships")
    .select("role, organizations ( id, name )")
    .eq("user_id", user.id)
    .order("created_at")
    .limit(1)
    .single();

  if (!membership?.organizations) {
    throw new Error("Signed-in user has no organization. The signup trigger should have created one.");
  }
  return { supabase, user, org: membership.organizations, role: membership.role };
}

export async function listProperties() {
  const { supabase, org } = await requireSession();
  const { data, error } = await supabase
    .from("properties")
    .select("id, title, kind, city, area, total_area_m2, bedrooms, status, updated_at")
    .eq("org_id", org.id)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getProperty(id: string) {
  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("properties")
    .select("*, levels ( * )")
    .eq("id", id)
    .order("sort", { referencedTable: "levels" })
    .maybeSingle();
  if (error) throw error;
  return data;
}

export function defaultLevelName(index: number) {
  if (index === 0) return "Ground floor";
  const suffix = index === 1 ? "st" : index === 2 ? "nd" : index === 3 ? "rd" : "th";
  return `${index}${suffix} floor`;
}
