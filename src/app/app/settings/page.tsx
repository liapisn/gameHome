import { Suspense } from "react";
import type { Metadata } from "next";
import { requireSession } from "@/lib/admin/data";
import { siteOrigin } from "@/lib/site-origin";
import {
  InviteForm,
  InviteRow,
  LeaveButton,
  MemberRow,
  RenameForm,
} from "@/components/admin/workspace-settings";

export const metadata: Metadata = { title: "Members · gameHome", robots: { index: false } };

export default function SettingsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-500">Loading…</p>}>
      <Settings />
    </Suspense>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-black/10 bg-white/70 p-5 sm:p-6">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-sm text-neutral-600">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

async function Settings() {
  const { supabase, user, org, role, workspaces } = await requireSession();
  const isOwner = role === "owner";

  const [{ data: members, error: membersError }, invites] = await Promise.all([
    supabase.rpc("list_workspace_members", { p_org: org.id }),
    isOwner
      ? supabase
          .from("invitations")
          .select("id, email, role, token, expires_at")
          .eq("org_id", org.id)
          .is("accepted_at", null)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; email: string; role: typeof role; token: string; expires_at: string }[] }),
  ]);
  if (membersError) throw membersError;

  const origin = await siteOrigin();
  const owners = (members ?? []).filter((m) => m.role === "owner").length;
  const canLeave = workspaces.length > 1 && (!isOwner || owners > 1);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Everyone in this workspace can see and edit its properties.
          {isOwner ? " Owners also manage members." : " Only owners can invite people."}
        </p>
      </div>

      {isOwner && (
        <Section title="Invite people" hint="They get an email with a sign-in link. New people get an account the first time they sign in.">
          <InviteForm />
        </Section>
      )}

      <Section title={`Members (${members?.length ?? 0})`}>
        <ul className="divide-y divide-black/10">
          {(members ?? []).map((m) => (
            <MemberRow
              key={m.user_id}
              userId={m.user_id}
              email={m.email}
              role={m.role}
              joinedAt={m.joined_at}
              isYou={m.user_id === user.id}
              canManage={isOwner}
            />
          ))}
        </ul>
      </Section>

      {isOwner && (invites.data?.length ?? 0) > 0 && (
        <Section title="Pending invitations">
          <ul className="divide-y divide-black/10">
            {invites.data!.map((i) => (
              <InviteRow
                key={i.email}
                id={i.id}
                email={i.email}
                role={i.role}
                expiresAt={i.expires_at}
                link={`${origin}/invite/${i.token}`}
              />
            ))}
          </ul>
        </Section>
      )}

      {isOwner && (
        <Section title="Workspace name">
          <RenameForm name={org.name} />
        </Section>
      )}

      <Section
        title="Leave workspace"
        hint={
          canLeave
            ? "You'll lose access to this workspace's properties until someone invites you again."
            : workspaces.length < 2
              ? "This is your only workspace, so you can't leave it."
              : "You're the only owner. Make someone else an owner before you leave."
        }
      >
        {canLeave && <LeaveButton name={org.name} />}
      </Section>
    </div>
  );
}
