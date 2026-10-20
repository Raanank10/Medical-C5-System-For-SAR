-- Tourniquet effectiveness on the server row (WP-2b, docs/GAP_CLOSURE_PLAN.md, V2.99.42).
--
-- From V2.99.42 the client sends a tourniquet effectiveness check (MSTART sweep "bleeding
-- controlled" / "bleeding continues") as TOURNIQUET_REASSESSMENT with tourniquet_status
-- 'effective' or 'bleeding_continues'. project_tourniquet_events() (001) writes that value into
-- tourniquets.tourniquet_status, but tourniquets_tourniquet_status_check only allowed
-- applied / reassessed / converted / downgraded / released / timed_out. The check failed inside
-- the AFTER INSERT trigger, which rolled back the event insert: the reassessment was rejected
-- (found by the live verification, 2026-10-20). Other devices read tourniquet_status to show a
-- remote tourniquet whose bleeding continues, so the two values are added rather than mapped to
-- 'reassessed'.

alter table tourniquets drop constraint if exists tourniquets_tourniquet_status_check;
alter table tourniquets add constraint tourniquets_tourniquet_status_check
  check (tourniquet_status = any (array['applied','reassessed','converted','downgraded','released','timed_out','effective','bleeding_continues']));
