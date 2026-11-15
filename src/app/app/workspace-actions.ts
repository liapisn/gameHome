"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession, isUuid } from "@/lib/admin/data";
import { setActiveWorkspace } from "@/lib/admin/workspace-cookie";

export type WorkspaceFormState = { error?: string };

/** Make one of the user's workspaces the active one and go to its properties. */
export async function switchWorkspace(orgId: string) {
  const { workspaces } = await requireSession();
  if (!isUuid(orgId) || !workspaces.some((w) => w.id === orgId)) {
    throw new Error("You're not a member of that workspace.");
  }
  await setActiveWorkspace(orgId);
  revalidatePath("/app", "layout");
  redirect("/app");
}

const NameSchema = z.string().trim().min(1, "Give the workspace a name").max(80, "Keep it under 80 characters");

export async function createWorkspace(_prev: WorkspaceFormState, formData: FormData): Promise<WorkspaceFormState> {
  const name = NameSchema.safeParse(String(formData.get("name") ?? ""));
  if (!name.success) return { error: name.error.issues[0]?.message };

  const { supabase } = await requireSession();
  const { data: orgId, error } = await supabase.rpc("create_workspace", { p_name: name.data });
  if (error) return { error: error.message };

  await setActiveWorkspace(orgId);
  revalidatePath("/app", "layout");
  redirect("/app");
}
