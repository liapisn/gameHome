"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/safe-next";
import { siteOrigin } from "@/lib/site-origin";

export type LoginState = { status: "idle" | "sent" | "error"; message?: string; email?: string };

const EmailSchema = z.email();

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = EmailSchema.safeParse(String(formData.get("email") ?? "").trim());
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };

  const origin = await siteOrigin();
  const next = safeNext(String(formData.get("next") ?? ""));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });

  if (error) {
    return {
      status: "error",
      message: error.status === 429 ? "Too many emails sent. Wait a minute and try again." : error.message,
    };
  }
  return { status: "sent", email: parsed.data };
}
