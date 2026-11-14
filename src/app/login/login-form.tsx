"use client";

import { useActionState } from "react";
import { sendMagicLink, type LoginState } from "./actions";

export function LoginForm({ next, linkError }: { next: string; linkError: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(sendMagicLink, { status: "idle" });

  if (state.status === "sent") {
    return (
      <div className="mt-6 rounded-xl border border-black/10 bg-white/70 p-4 text-sm">
        <p className="font-medium">Check your inbox</p>
        <p className="mt-1 text-neutral-600">
          We sent a sign-in link to <span className="font-medium text-neutral-900">{state.email}</span>. Open it on
          this device.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <label className="text-sm font-medium" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        className="rounded-lg border border-black/15 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
      {(state.status === "error" || linkError) && (
        <p className="text-sm text-red-700" role="alert">
          {state.message ?? "That link is invalid or has expired. Request a new one."}
        </p>
      )}
    </form>
  );
}
