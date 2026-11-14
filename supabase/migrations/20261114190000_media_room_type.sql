-- The owner's room type for a photo: bounds where the tour build may place it and which room's
-- furniture it may feed. Values match ROOM_TYPES in src/lib/floorplan.ts.
create type public.room_type as enum (
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'hallway', 'office', 'storage', 'stairs', 'balcony'
);

alter table public.media add column room_type public.room_type;
