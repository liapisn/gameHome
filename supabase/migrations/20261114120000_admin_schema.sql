-- gameHome admin schema: organizations, properties, levels, media, jobs, tours.
-- Every table is scoped to an organization and protected by RLS.

-- ─── Organizations & membership ──────────────────────────────────────────────

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create type public.member_role as enum ('owner', 'editor');

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'editor',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- Security definer so policies can check membership without recursing into memberships' own RLS.
create function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = (select auth.uid())
  );
$$;

-- Every new user gets a personal organization.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_org uuid;
begin
  insert into public.organizations (name)
  values (split_part(new.email, '@', 1) || '''s workspace')
  returning id into new_org;

  insert into public.memberships (org_id, user_id, role)
  values (new_org, new.id, 'owner');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Properties ──────────────────────────────────────────────────────────────

create type public.property_kind as enum ('apartment', 'house', 'studio', 'maisonette', 'villa', 'other');
create type public.property_status as enum ('draft', 'processing', 'ready', 'published');

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  title text not null,
  kind public.property_kind not null default 'apartment',
  address text,
  city text,
  area text,
  lat double precision,
  lng double precision,
  total_area_m2 numeric(8, 2),
  bedrooms smallint,
  bathrooms smallint,
  description text,
  status public.property_status not null default 'draft',
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index properties_org_idx on public.properties (org_id, updated_at desc);

create table public.levels (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  name text not null,
  sort smallint not null default 0,
  ceiling_height numeric(4, 2) not null default 2.7,
  floorplan_path text,
  created_at timestamptz not null default now()
);
create index levels_property_idx on public.levels (property_id, sort);

create type public.media_kind as enum ('photo', 'floorplan');

create table public.media (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  level_id uuid references public.levels (id) on delete set null,
  kind public.media_kind not null,
  storage_path text not null unique,
  width integer,
  height integer,
  bytes integer,
  hint text,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index media_property_idx on public.media (property_id, kind, sort);

-- ─── Jobs & tours ────────────────────────────────────────────────────────────

create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed');

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  type text not null default 'build_tour',
  status public.job_status not null default 'queued',
  progress jsonb not null default '{}'::jsonb,
  error text,
  attempts smallint not null default 0,
  worker_id text,
  requested_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_property_idx on public.jobs (property_id, created_at desc);
create index jobs_queue_idx on public.jobs (created_at) where status = 'queued';

create table public.tours (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  version integer not null,
  tour_path text not null,
  plan_paths jsonb not null default '[]'::jsonb,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  unique (property_id, version)
);
create unique index tours_one_current_idx on public.tours (property_id) where is_current;

-- Atomically claim the oldest queued job. Called by the worker with the service role only.
create function public.claim_next_job(p_worker text)
returns setof public.jobs
language sql
security definer
set search_path = ''
as $$
  update public.jobs j
  set status = 'running', started_at = now(), attempts = j.attempts + 1, worker_id = p_worker
  where j.id = (
    select id from public.jobs
    where status = 'queued'
    order by created_at
    for update skip locked
    limit 1
  )
  returning j.*;
$$;
revoke execute on function public.claim_next_job(text) from public, anon, authenticated;

-- ─── updated_at ──────────────────────────────────────────────────────────────

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger properties_touch before update on public.properties
  for each row execute function public.touch_updated_at();

-- ─── Row level security ──────────────────────────────────────────────────────

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.properties enable row level security;
alter table public.levels enable row level security;
alter table public.media enable row level security;
alter table public.jobs enable row level security;
alter table public.tours enable row level security;

create policy "members read their organizations" on public.organizations
  for select to authenticated using (public.is_org_member(id));

create policy "users read their memberships" on public.memberships
  for select to authenticated using (user_id = (select auth.uid()) or public.is_org_member(org_id));

create policy "members manage properties" on public.properties
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

create policy "members manage levels" on public.levels
  for all to authenticated
  using (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id)))
  with check (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id)));

create policy "members manage media" on public.media
  for all to authenticated
  using (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id)))
  with check (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id)));

-- Members can read jobs and queue new ones; only the worker (service role) updates them.
create policy "members read jobs" on public.jobs
  for select to authenticated
  using (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id)));

create policy "members queue jobs" on public.jobs
  for insert to authenticated
  with check (
    status = 'queued'
    and exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id))
  );

create policy "members read tours" on public.tours
  for select to authenticated
  using (exists (select 1 from public.properties p where p.id = property_id and public.is_org_member(p.org_id)));

-- ─── Realtime: live job progress ─────────────────────────────────────────────

alter publication supabase_realtime add table public.jobs;

-- ─── Storage ─────────────────────────────────────────────────────────────────
-- Paths: org/<org_id>/property/<property_id>/{floorplans,photos}/<file>

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('property-media', 'property-media', false, 52428800, array['image/jpeg', 'image/png', 'image/webp']),
  ('tours', 'tours', false, 52428800, array['application/json', 'model/gltf-binary', 'image/webp', 'image/jpeg']);

create policy "members manage property media files" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'property-media'
    and (storage.foldername(name))[1] = 'org'
    and public.is_org_member(((storage.foldername(name))[2])::uuid)
  )
  with check (
    bucket_id = 'property-media'
    and (storage.foldername(name))[1] = 'org'
    and public.is_org_member(((storage.foldername(name))[2])::uuid)
  );

create policy "members read tour files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tours'
    and (storage.foldername(name))[1] = 'org'
    and public.is_org_member(((storage.foldername(name))[2])::uuid)
  );
