-- Soft delete for properties: deleting sets deleted_at and keeps the row, its floors, media and files.
-- RLS hides deleted properties from members, and with them their levels, media, jobs and tours
-- (those policies check membership through a select on properties, which now skips deleted rows).
-- To restore one, clear deleted_at with the service role (SQL editor).

alter table public.properties add column deleted_at timestamptz;

drop index public.properties_org_idx;
create index properties_org_idx on public.properties (org_id, updated_at desc) where deleted_at is null;

-- Split the old "for all" policy so members only ever see and edit live properties,
-- and can no longer hard-delete them.
drop policy "members manage properties" on public.properties;

create policy "members read live properties" on public.properties
  for select to authenticated
  using (deleted_at is null and public.is_org_member(org_id));

create policy "members create properties" on public.properties
  for insert to authenticated
  with check (deleted_at is null and public.is_org_member(org_id));

create policy "members update live properties" on public.properties
  for update to authenticated
  using (deleted_at is null and public.is_org_member(org_id))
  with check (deleted_at is null and public.is_org_member(org_id));

-- Soft delete goes through this function: an update that hides the row from its own select
-- policy is rejected by RLS, so the function checks membership itself and runs as definer.
create function public.soft_delete_property(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.properties
  set deleted_at = now()
  where id = p_id
    and deleted_at is null
    and public.is_org_member(org_id);
  if not found then
    raise exception 'Property not found' using errcode = 'P0002';
  end if;
  -- Don't spend the worker on a property nobody can see any more.
  update public.jobs
  set status = 'failed', error = 'Property was deleted.', finished_at = now()
  where property_id = p_id and status = 'queued';
end;
$$;
revoke execute on function public.soft_delete_property(uuid) from public, anon;
grant execute on function public.soft_delete_property(uuid) to authenticated;
