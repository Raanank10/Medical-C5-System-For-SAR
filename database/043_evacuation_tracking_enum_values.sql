-- Evacuation tracking (V2.99.33): where each casualty was taken and how Magen David Adom
-- classified them, plus external casualty counts from United Hatzalah and Yedidim alongside
-- MDA and police.
--
-- - PATIENT_EVACUATION_UPDATED: a later update of a patient's evacuation destination and/or MDA
--   classification (by PC/CC/chamal/physician, once MDA reports back). The same two fields can
--   also ride on PATIENT_HANDED_OVER when they are already known at handover.
-- - external_source 'yedidim': Yedidim is its own organization, separate from United Hatzalah
--   ('united_hatzalah', already in the enum since 001). The client used to label its 'UH'
--   button as Yedidim; both now exist as separate sources.
--
-- Own file/transaction: Postgres forbids using a new enum value in the same transaction that
-- adds it (same reason 006/019/024/032 split their enum adds this way) - 044 uses these values.

alter type event_type add value if not exists 'PATIENT_EVACUATION_UPDATED';
alter type external_source add value if not exists 'yedidim';
