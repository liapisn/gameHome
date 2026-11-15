"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { requireOwner, requireSession, isUuid } from "@/lib/admin/data";
import { clearActiveWorkspace } from "@/lib/admin/workspace-cookie";
import { siteOrigin } from "@/lib/site-origin";
import type { Database } from "@/lib/supabase/database.types";

export type SettingsState = { error?: string; ok?: string; link?: string };

const RoleSchema = z.enum(["owner", "editor"]);

const done = (ok: string, extra: Partial<SettingsState> = {}): SettingsState => {
  revalidatePath("/app/settings");
  return { ok, ...extra };
};

// ─── Workspace ────────────────────────────────────────────────────────────────

export async function renameWorkspace(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const name = z.string().trim().min(1, "Give the workspace a name").max(80).safeParse(String(formData.get("name") ?? ""));
  if (!name.success) return { error: name.error.issues[0]?.message };

  const { supabase, org } = await requireOwner();
  const { error } = await supabase.from("organizations").update({ name: name.data }).eq("id", org.id);
  if (error) return { error: error.message };
  revalidatePath("/app", "layout");
  return { ok: "Saved" };
}

export async function leaveWorkspace(_prev: SettingsState, _formData: FormData): Promise<SettingsState> {
  const { supabase, user, org, workspaces } = await requireSession();
  if (workspaces.length < 2) return { error: "This is your only workspace. Create or join another one before leaving it." };

  const { data, error } = await supabase
    .from("memberships")
    .delete()
    .eq("org_id", org.id)
    .eq("user_id", user.id)
    .select("user_id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Couldn't leave this workspace." };

  await clearActiveWorkspace();
  revalidatePath("/app", "layout");
  redirect("/app");
}

// ─── Members ──────────────────────────────────────────────────────────────────

export async function changeRole(userId: string, _prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const role = RoleSchema.safeParse(formData.get("role"));
  if (!isUuid(userId) || !role.success) return { error: "Pick a role." };

  const { supabase, org } = await requireOwner();
  const { data, error } = await supabase
    .from("memberships")
    .update({ role: role.data })
    .eq("org_id", org.id)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Couldn't change that member's role." };
  revalidatePath("/app", "layout");
  return done("Role updated");
}

export async function removeMember(userId: string, _prev: SettingsState, _formData: FormData): Promise<SettingsState> {
  if (!isUuid(userId)) return { error: "Unknown member." };
  const { supabase, org, user } = await requireOwner();
  if (userId === user.id) return { error: "Use “Leave workspace” to remove yourself." };

  const { data, error } = await supabase
    .from("memberships")
    .delete()
    .eq("org_id", org.id)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Couldn't remove that member." };
  return done("Removed");
}

// ─── Invitations ──────────────────────────────────────────────────────────────

/**
 * Emails a sign-in link that lands on the invite page. Sent from a throwaway client using the
 * implicit flow: with PKCE the code verifier would be stored in the *owner's* browser, and the
 * link would fail on the invitee's device. The invite page picks the session up from the URL.
 */
async function emailInvite(email: string, link: string) {
  const mailer = createSupabase<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { flowType: "implicit", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const path = new URL(link).pathname;
  const { error } = await mailer.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${new URL(link).origin}/auth/callback?next=${encodeURIComponent(path)}` },
  });
  return error;
}

/** Creates (or replaces) the open invitation for `email` and emails it. */
async function invite(email: string, role: z.infer<typeof RoleSchema>): Promise<SettingsState> {
  const { supabase, org } = await requireOwner();

  const { data: members, error: membersError } = await supabase.rpc("list_workspace_members", { p_org: org.id });
  if (membersError) return { error: membersError.message };
  if (members?.some((m) => m.email.toLowerCase() === email)) return { error: `${email} is already a member.` };

  // One open invitation per email: a new invite (or "Resend") replaces it with a fresh link and expiry.
  const { error: clearError } = await supabase
    .from("invitations")
    .delete()
    .eq("org_id", org.id)
    .eq("email", email)
    .is("accepted_at", null);
  if (clearError) return { error: clearError.message };

  const { data: inv, error } = await supabase
    .from("invitations")
    .insert({ org_id: org.id, email, role })
    .select("token")
    .single();
  if (error) return { error: error.message };

  const link = `${await siteOrigin()}/invite/${inv.token}`;
  const mailError = await emailInvite(email, link);
  if (mailError) {
    const why = mailError.status === 429 ? "the email limit was hit" : mailError.message;
    return done(`Invitation created, but the email to ${email} wasn't sent (${why}).`, { link });
  }
  return done(`Invitation emailed to ${email}.`, { link });
}

const InviteSchema = z.object({ email: z.email("Enter a valid email address."), role: RoleSchema });

export async function inviteMember(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const parsed = InviteSchema.safeParse({
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    role: formData.get("role") ?? "editor",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  return invite(parsed.data.email, parsed.data.role);
}

export async function resendInvite(inviteId: string, _prev: SettingsState, _formData: FormData): Promise<SettingsState> {
  if (!isUuid(inviteId)) return { error: "Unknown invitation." };
  const { supabase } = await requireOwner();
  const { data: inv, error } = await supabase.from("invitations").select("email, role").eq("id", inviteId).maybeSingle();
  if (error) return { error: error.message };
  if (!inv) return { error: "That invitation no longer exists." };
  return invite(inv.email, inv.role);
}

export async function revokeInvite(inviteId: string, _prev: SettingsState, _formData: FormData): Promise<SettingsState> {
  if (!isUuid(inviteId)) return { error: "Unknown invitation." };
  const { supabase, org } = await requireOwner();
  const { error } = await supabase.from("invitations").delete().eq("id", inviteId).eq("org_id", org.id);
  if (error) return { error: error.message };
  return done("Invitation revoked");
}
