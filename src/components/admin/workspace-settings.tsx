"use client";

import { useActionState, useState } from "react";
import {
  changeRole,
  inviteMember,
  leaveWorkspace,
  removeMember,
  renameWorkspace,
  resendInvite,
  revokeInvite,
  type SettingsState,
} from "@/app/app/settings/actions";
import type { MemberRole } from "@/lib/admin/data";

type Action = (state: SettingsState, formData: FormData) => Promise<SettingsState>;

const inputClass =
  "rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900";
const primaryButton =
  "rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60";
const quietButton = "rounded-lg px-2.5 py-1.5 text-sm hover:bg-black/5 disabled:opacity-60";

function Message({ state }: { state: SettingsState }) {
  if (state.error) return <p className="text-xs text-red-700">{state.error}</p>;
  if (!state.ok) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-neutral-600">{state.ok}</p>
      {state.link && (
        <>
          <p className="text-xs text-neutral-600">Or share the invite link yourself:</p>
          <CopyLink link={state.link} />
        </>
      )}
    </div>
  );
}

export function CopyLink({ link, compact = false }: { link: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  if (compact) {
    return (
      <button type="button" onClick={copy} className={quietButton}>
        {copied ? "Copied" : "Copy link"}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className={`${inputClass} min-w-0 flex-1 text-xs`} />
      <button type="button" onClick={copy} className="rounded-lg border border-black/15 px-3 py-2 text-sm hover:bg-black/5">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function RenameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(renameWorkspace, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <input name="name" required maxLength={80} defaultValue={name} aria-label="Workspace name" className={`${inputClass} w-full max-w-sm`} />
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function InviteForm() {
  const [state, action, pending] = useActionState<SettingsState, FormData>(inviteMember, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          required
          placeholder="name@example.com"
          aria-label="Email"
          className={`${inputClass} min-w-0 flex-1 basis-60`}
        />
        <select name="role" defaultValue="editor" aria-label="Role" className={inputClass}>
          <option value="editor">Editor</option>
          <option value="owner">Owner</option>
        </select>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Inviting…" : "Invite"}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}

export function MemberRow({
  userId,
  email,
  role,
  joinedAt,
  isYou,
  canManage,
}: {
  userId: string;
  email: string;
  role: MemberRole;
  joinedAt: string;
  isYou: boolean;
  canManage: boolean;
}) {
  const [roleState, roleAction, rolePending] = useActionState<SettingsState, FormData>(
    changeRole.bind(null, userId) as Action,
    {},
  );
  const [removeState, removeAction, removePending] = useActionState<SettingsState, FormData>(
    removeMember.bind(null, userId) as Action,
    {},
  );
  const state = removeState.error ? removeState : roleState;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {email}
          {isYou && <span className="ml-2 font-normal text-neutral-500">(you)</span>}
        </p>
        <p className="text-xs text-neutral-500">Joined {new Date(joinedAt).toLocaleDateString()}</p>
        {state.error && <p className="mt-1 text-xs text-red-700">{state.error}</p>}
      </div>
      {canManage ? (
        <form action={roleAction}>
          <select
            name="role"
            defaultValue={role}
            key={role}
            disabled={rolePending}
            aria-label={`Role of ${email}`}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className={`${inputClass} py-1.5`}
          >
            <option value="editor">Editor</option>
            <option value="owner">Owner</option>
          </select>
        </form>
      ) : (
        <span className="text-sm text-neutral-600">{role === "owner" ? "Owner" : "Editor"}</span>
      )}
      {canManage && !isYou && (
        <form
          action={removeAction}
          onSubmit={(e) => {
            if (!confirm(`Remove ${email} from this workspace?`)) e.preventDefault();
          }}
        >
          <button type="submit" disabled={removePending} className={`${quietButton} text-red-700`}>
            Remove
          </button>
        </form>
      )}
    </li>
  );
}

export function InviteRow({
  id,
  email,
  role,
  expiresAt,
  link,
}: {
  id: string;
  email: string;
  role: MemberRole;
  expiresAt: string;
  link: string;
}) {
  const [resendState, resendAction, resendPending] = useActionState<SettingsState, FormData>(
    resendInvite.bind(null, id) as Action,
    {},
  );
  const [revokeState, revokeAction, revokePending] = useActionState<SettingsState, FormData>(
    revokeInvite.bind(null, id) as Action,
    {},
  );
  const expired = new Date(expiresAt) < new Date();
  const error = resendState.error ?? revokeState.error;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{email}</p>
        <p className="text-xs text-neutral-500">
          {role === "owner" ? "Owner" : "Editor"} ·{" "}
          {expired ? (
            <span className="text-amber-700">expired</span>
          ) : (
            `expires ${new Date(expiresAt).toLocaleDateString()}`
          )}
        </p>
        {error ? (
          <p className="mt-1 text-xs text-red-700">{error}</p>
        ) : (
          resendState.ok && <p className="mt-1 text-xs text-neutral-600">{resendState.ok}</p>
        )}
      </div>
      {!expired && <CopyLink link={link} compact />}
      <form action={resendAction}>
        <button type="submit" disabled={resendPending} className={quietButton}>
          {resendPending ? "Sending…" : "Resend"}
        </button>
      </form>
      <form action={revokeAction}>
        <button type="submit" disabled={revokePending} className={`${quietButton} text-red-700`}>
          Revoke
        </button>
      </form>
    </li>
  );
}

export function LeaveButton({ name }: { name: string }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(leaveWorkspace, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Leave “${name}”? You'll lose access to its properties.`)) e.preventDefault();
      }}
      className="flex flex-col gap-2"
    >
      <div>
        <button type="submit" disabled={pending} className="rounded-lg border border-red-700/30 px-4 py-2 text-sm text-red-700 hover:bg-red-50">
          {pending ? "Leaving…" : "Leave workspace"}
        </button>
      </div>
      <Message state={state} />
    </form>
  );
}
