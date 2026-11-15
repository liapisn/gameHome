"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setActiveWorkspace } from "@/lib/admin/workspace-cookie";

export type AcceptState = { error?: string };

export async function acceptInvitation(token: string, _prev: AcceptState, _formData: FormData): Promise<AcceptState> {
  const supabase = await createClient();
  const { data: orgId, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) return { error: error.message };

  await setActiveWorkspace(orgId);
  revalidatePath("/app", "layout");
  redirect("/app");
}

/** Signed in with a different email than the invited one: sign out and come back here. */
export async function signOutAndReturn(token: string) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
}
