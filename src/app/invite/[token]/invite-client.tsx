"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { acceptInvitation, type AcceptState } from "./actions";

/**
 * Invite emails use Supabase's implicit flow, so the session arrives in the URL fragment
 * (#access_token=…&refresh_token=…), which the server never sees. Store it as the cookie
 * session, drop the fragment, and re-render the page signed in.
 */
export function SessionFromLink() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (!access_token && !params.get("error_description")) return;

    history.replaceState(null, "", window.location.pathname + window.location.search);
    const signIn =
      access_token && refresh_token
        ? createClient().auth.setSession({ access_token, refresh_token })
        : Promise.resolve({ error: new Error("link") });
    signIn.then(({ error }) => {
      if (error) setFailed(true);
      else router.refresh();
    });
  }, [router]);

  if (failed) {
    return (
      <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        That email link has expired or was already used. Sign in below to accept the invitation.
      </p>
    );
  }
  return null;
}

export function AcceptButton({ token, workspace }: { token: string; workspace: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(
    acceptInvitation.bind(null, token) as (s: AcceptState, f: FormData) => Promise<AcceptState>,
    {},
  );
  return (
    <form action={action} className="mt-6 flex flex-col gap-2">
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
      >
        {pending ? "Joining…" : `Join ${workspace}`}
      </button>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
    </form>
  );
}
