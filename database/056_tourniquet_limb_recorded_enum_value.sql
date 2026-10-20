-- Tourniquet follow-ups (WP-2b, docs/GAP_CLOSURE_PLAN.md, V2.99.42) - enum value only. 057 projects it.
--
-- Kept in its own file, like 043/044, 049/050 and 051/052: a new enum value cannot be used in the
-- same transaction that adds it.
--
-- TOURNIQUET_LIMB_RECORDED: the limb of a tourniquet recorded after it was applied (the MSTART
-- sweep lets a medic apply first and pick the limb later). The client already writes this name;
-- until now it never left the phone, so the server row kept limb 'unknown' and every other device
-- showed "לא ידוע" for that tourniquet.

alter type event_type add value if not exists 'TOURNIQUET_LIMB_RECORDED';
