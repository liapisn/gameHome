-- The room the owner says a photo was taken in: a room id from the stored plan of the photo's
-- floor (levels.plan). Cleared when that plan is read again, since room ids can change.
alter table public.media add column room_id text;
