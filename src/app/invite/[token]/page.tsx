import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { createClient, getUser } from "@/lib/supabase/server";
import { signOutAndReturn } from "./actions";
import { AcceptButton, SessionFromLink } from "./invite-client";

export const metadata: Metadata = { title: "Invitation · gameHome", robots: { index: false } };

const buttonClass =
  "mt-6 block rounded-lg bg-neutral-900 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-neutral-700";

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          gameHome
        </Link>
        <SessionFromLink />
        <Suspense fallback={<div className="mt-8 h-40" />}>
          <Invitation params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function Invitation({ params }: { params: PageProps<"/invite/[token]">["params"] }) {
  const { token } = await params;
  const supabase = await createClient();
  const [{ data }, user] = await Promise.all([
    /^[0-9a-f]{64}$/.test(token) ? supabase.rpc("get_invitation", { p_token: token }) : Promise.resolve({ data: null }),
    getUser(),
  ]);
  const inv = data?.[0];

  if (!inv) {
    return (
      <Notice title="Invitation not found">
        This link isn&apos;t valid. It may have been revoked or replaced by a newer invitation. Ask for a new one.
      </Notice>
    );
  }
  if (inv.status === "expired") {
    return (
      <Notice title="Invitation expired">
        Ask {inv.inviter_email ?? "the person who invited you"} to send a new one.
      </Notice>
    );
  }
  if (inv.status === "accepted") {
    return (
      <Notice title="Invitation already used">
        {user ? (
          <Link href="/app" className={buttonClass}>
            Go to your workspaces
          </Link>
        ) : (
          <Link href="/login?next=/app" className={buttonClass}>
            Sign in
          </Link>
        )}
      </Notice>
    );
  }

  const intro = (
    <>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight">Join {inv.org_name}</h1>
      <p className="mt-2 text-sm text-neutral-600">
        {inv.inviter_email ?? "Someone"} invited <span className="font-medium text-neutral-900">{inv.email}</span> to
        work on properties in <span className="font-medium text-neutral-900">{inv.org_name}</span> as{" "}
        {inv.role === "owner" ? "an owner" : "an editor"}.
      </p>
    </>
  );

  if (!user) {
    return (
      <>
        {intro}
        <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className={buttonClass}>
          Sign in as {inv.email}
        </Link>
      </>
    );
  }

  if ((user.email ?? "").toLowerCase() !== inv.email) {
    return (
      <>
        {intro}
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You&apos;re signed in as {user.email}. Sign in as {inv.email} to accept.
        </p>
        <form action={signOutAndReturn.bind(null, token)}>
          <button type="submit" className={`${buttonClass} w-full`}>
            Switch account
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      {intro}
      <AcceptButton token={token} workspace={inv.org_name} />
    </>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-2 text-sm text-neutral-600">{children}</div>
    </>
  );
}
