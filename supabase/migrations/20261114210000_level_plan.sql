-- The floor plan as the engine read it (rooms, walls, openings; a FloorPlan from
-- src/lib/floorplan.ts). Read once when the plan is uploaded and corrected by the owner;
-- tour builds reuse it, so room ids stay stable for tagging photos with a room.
alter table public.levels add column plan jsonb;
