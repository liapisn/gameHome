-- Several workspaces per user: owners invite people by email, rename the workspace and manage
-- members; anyone can create a new workspace. A workspace is an `organizations` row.

-- ─── Owner check ─────────────────────────────────────────────────────────────

create function public.is_org_owner(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = (select auth.uid()) and m.role = 'owner'
  );
$$;

-- ─── Renaming workspaces, changing roles, removing and leaving ──────────────

-- Only the name of a workspace and the role of a membership can change from the app.
revoke update on public.organizations from authenticated, anon;
grant update (name) on public.organizations to authenticated;
revoke update on public.memberships from authenticated, anon;
grant update (role) on public.memberships to authenticated;

create policy "owners rename their organizations" on public.organizations
  for update to authenticated
  using (public.is_org_owner(id))
  with check (public.is_org_owner(id));

create policy "owners change member roles" on public.memberships
  for update to authenticated
  using (public.is_org_owner(org_id))
  with check (public.is_org_owner(org_id));

create policy "owners remove members, members leave" on public.memberships
  for delete to authenticated
  using (public.is_org_owner(org_id) or user_id = (select auth.uid()));

-- A workspace always keeps an owner: the last one can't leave, be removed or be demoted.
-- Deleting the user or the workspace itself still cascades (their row is already gone by then).
create function public.memberships_keep_an_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return coalesce(new, old);
  end if;
  if not exists (select 1 from public.organizations o where o.id = old.org_id)
     or not exists (select 1 from auth.users u where u.id = old.user_id) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.org_id = old.org_id and m.user_id <> old.user_id and m.role = 'owner'
  ) then
    raise exception 'A workspace needs at least one owner.' using errcode = 'P0001', hint = 'last_owner';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger memberships_keep_an_owner
  before update of role or delete on public.memberships
  for each row execute function public.memberships_keep_an_owner();

-- ─── Creating workspaces ─────────────────────────────────────────────────────

create function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  v_name text := btrim(p_name);
  new_org uuid;
begin
  if uid is null then
    raise exception 'Sign in first.';
  end if;
  if v_name = '' or length(v_name) > 80 then
    raise exception 'Give the workspace a name of up to 80 characters.';
  end if;

  insert into public.organizations (name) values (v_name) returning id into new_org;
  insert into public.memberships (org_id, user_id, role) values (new_org, uid, 'owner');
  return new_org;
end;
$$;
revoke execute on function public.create_workspace(text) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;

-- ─── Members (emails live in auth.users) ─────────────────────────────────────

create function public.list_workspace_members(p_org uuid)
returns table (user_id uuid, email text, role public.member_role, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.org_id = p_org and public.is_org_member(p_org)
  order by m.role, u.email;
$$;
revoke execute on function public.list_workspace_members(uuid) from public, anon;
grant execute on function public.list_workspace_members(uuid) to authenticated;

-- ─── Invitations ─────────────────────────────────────────────────────────────

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email)),
  role public.member_role not null default 'editor',
  -- 244 random bits; the invite link is /invite/<token>.
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  invited_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null
);
create unique index invitations_one_open_idx on public.invitations (org_id, email) where accepted_at is null;

alter table public.invitations enable row level security;

create policy "owners read invitations" on public.invitations
  for select to authenticated using (public.is_org_owner(org_id));

create policy "owners invite" on public.invitations
  for insert to authenticated
  with check (public.is_org_owner(org_id) and accepted_at is null and accepted_by is null);

create policy "owners revoke invitations" on public.invitations
  for delete to authenticated using (public.is_org_owner(org_id));

-- What the invite page shows before the visitor is a member (the token is the secret).
create function public.get_invitation(p_token text)
returns table (
  org_id uuid,
  org_name text,
  email text,
  role public.member_role,
  inviter_email text,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    i.org_id,
    o.name,
    i.email,
    i.role,
    u.email::text,
    case
      when i.accepted_at is not null then 'accepted'
      when i.expires_at < now() then 'expired'
      else 'open'
    end
  from public.invitations i
  join public.organizations o on o.id = i.org_id
  left join auth.users u on u.id = i.invited_by
  where i.token = p_token;
$$;
revoke execute on function public.get_invitation(text) from public;
grant execute on function public.get_invitation(text) to anon, authenticated;

-- Join the workspace if the signed-in user's email is the invited one. Returns the workspace id.
create function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  user_email text := lower((select auth.jwt()) ->> 'email');
  inv public.invitations%rowtype;
begin
  if uid is null then
    raise exception 'Sign in first.';
  end if;

  select * into inv from public.invitations where token = p_token for update;
  if not found then
    raise exception 'This invitation link is not valid.';
  end if;
  if inv.accepted_at is not null then
    if inv.accepted_by = uid then
      return inv.org_id;
    end if;
    raise exception 'This invitation was already used.';
  end if;
  if inv.expires_at < now() then
    raise exception 'This invitation has expired. Ask for a new one.';
  end if;
  if user_email is distinct from inv.email then
    raise exception 'This invitation is for %. Sign in with that email to accept it.', inv.email;
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (inv.org_id, uid, inv.role)
  on conflict (org_id, user_id) do nothing;

  update public.invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.org_id;
end;
$$;
revoke execute on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

revoke execute on function public.is_org_owner(uuid) from anon;
