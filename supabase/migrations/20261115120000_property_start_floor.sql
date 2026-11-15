-- The floor the home starts on (0 = ground floor, 3 = an apartment on the 3rd floor, -1 = basement).
-- Its floors are numbered up from here (their default names, and what the plan reader is told).
alter table public.properties
  add column start_floor smallint not null default 0
  check (start_floor between -5 and 200);
