-- MSTART sweep summary crosses devices (WP-11, docs/GAP_CLOSURE_PLAN.md, V2.99.47) - enum value only.
--
-- A medic finishing an MSTART sweep (completeMstartSweep in index.html) writes MSTART_SWEEP_COMPLETED
-- with the sweep's counts (red/yellow/green/black, trapped, immobile, tourniquets, patients without
-- full vitals). The PC's "סריקות MSTART פעילות / הושלמו" board and task board read it, but it never
-- left the medic's phone, so a PC on another phone never saw a sweep finish. No projection: the PC
-- reads it from the events it already pulls (sync-log GET, events RLS). Every number in it is also
-- derivable from the patients themselves; the event is the medic's "sweep done" signal.
alter type event_type add value if not exists 'MSTART_SWEEP_COMPLETED';
