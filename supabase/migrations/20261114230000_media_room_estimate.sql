-- First guess of the room a photo was taken in (src/lib/tour/estimate-room.ts):
-- { levelId, roomId, confidence, reason, model, at }. The owner's own choice (room_id) wins over it.
alter table public.media add column room_estimate jsonb;
