-- Tourniquet time entered from the body (repo owner, 2026-11-08) - enum value only. 081 projects it.
--
-- Kept in its own file, like 043/044, 049/050, 051/052 and 056/057: a new enum value cannot be used
-- in the same transaction that adds it.
--
-- TOURNIQUET_TIME_RECORDED: the time a tourniquet went on, read from the 4 digits a first responder
-- wrote on the patient and entered (or corrected) by medical staff after the tourniquet was
-- recorded. Payload: limb, application_time (the new time), previous_application_time (the time
-- the server row has, or null), time_code, time_entered_at (the phone's clock at entry),
-- previous_time_source.

alter type event_type add value if not exists 'TOURNIQUET_TIME_RECORDED';
