-- WP-24 / database/084 checks (24), run on the stand-ins in scripts/rls_test_084_standin.sql. Each check
-- raises on failure. Results 2026-11-18, PostgreSQL 16: 24 of 24 passed, 084 re-applies as a no-op.
\set ON_ERROR_STOP 1
insert into incidents values ('00000000-0000-4000-8000-000000000001');
insert into profiles values
 ('10000000-0000-4000-8000-000000000001','medic'),('10000000-0000-4000-8000-000000000002','pc'),
 ('10000000-0000-4000-8000-000000000003','cc'),('10000000-0000-4000-8000-000000000004','chamal'),
 ('10000000-0000-4000-8000-000000000005','logistics_officer'),('10000000-0000-4000-8000-000000000006','admin'),
 ('10000000-0000-4000-8000-000000000007','physician');
create function t_req(client text) returns uuid language plpgsql as $$ declare r uuid; begin
  insert into events(incident_id,actor_id,device_id,local_event_id,type,payload_json) values ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','dev-m',client,'SUPPLY_REQUEST_CREATED',jsonb_build_object('id',client,'items','[]'::jsonb));
  select id into r from supply_requests where origin_client_request_id=client; return r; end $$;
create function t_ev(actor text, typ text, p jsonb) returns void language sql as $$
  insert into events(incident_id,actor_id,device_id,local_event_id,type,payload_json) values ('00000000-0000-4000-8000-000000000001',('10000000-0000-4000-8000-00000000000'||actor)::uuid,'dev-'||actor,gen_random_uuid()::text,typ::event_type,p) $$;
create function t_st(r uuid) returns text language sql as $$ select status::text||'/'||request_level||'/'||coalesce(cancel_reason,'-') from supply_requests where id=r $$;
create function t_eq(got text, want text, label text) returns void language plpgsql as $$ begin
  if got is distinct from want then raise exception 'FAIL %: got % want %', label, got, want; end if; raise notice 'ok %', label; end $$;
do $$ declare a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; g uuid; h uuid; n int; begin
  -- 1 PC cancels a request still at its level, with a reason
  a := t_req('A'); perform t_ev('2','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',a,'reason','not_needed'));
  perform t_eq(t_st(a),'cancelled/medic_to_pc/not_needed','1 pc cancels requested medic_to_pc');
  perform t_eq((select cancelled_by::text from supply_requests where id=a),'10000000-0000-4000-8000-000000000002','1 cancelled_by');
  -- 2 nothing moves a cancelled row: approve, escalate, dispatch, in transit, received
  perform t_ev('2','RESUPPLY_APPROVED_FROM_PC_TRUCK',jsonb_build_object('supply_request_id',a));
  perform t_ev('2','RESUPPLY_ESCALATED_TO_CC',jsonb_build_object('supply_request_id',a));
  perform t_ev('5','SUPPLY_REQUEST_DISPATCHED',jsonb_build_object('supply_request_id',a));
  perform t_ev('5','SUPPLY_REQUEST_IN_TRANSIT',jsonb_build_object('supply_request_id',a));
  perform t_ev('2','SUPPLY_REQUEST_RECEIVED',jsonb_build_object('supply_request_id',a));
  perform t_eq(t_st(a),'cancelled/medic_to_pc/not_needed','2 cancelled is final');
  -- 3 PC cannot cancel once escalated; CC can
  b := t_req('B'); perform t_ev('2','RESUPPLY_ESCALATED_TO_CC',jsonb_build_object('supply_request_id',b));
  perform t_ev('2','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',b,'reason','duplicate'));
  perform t_eq(t_st(b),'requested/pc_to_logo/-','3 pc refused at pc_to_logo');
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',b,'reason','duplicate'));
  perform t_eq(t_st(b),'cancelled/pc_to_logo/duplicate','3 cc cancels pc_to_logo');
  -- 4 never 'approved' (truck already issued), for anyone
  c := t_req('C'); perform t_ev('2','RESUPPLY_APPROVED_FROM_PC_TRUCK',jsonb_build_object('supply_request_id',c));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',c,'reason','not_needed'));
  perform t_ev('6','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',c,'reason','not_needed'));
  perform t_eq(t_st(c),'approved/medic_to_pc/-','4 approved not cancellable');
  -- 5 chamal cancels a dispatched one; then logistics received does nothing
  d := t_req('D'); perform t_ev('2','RESUPPLY_ESCALATED_TO_CC',jsonb_build_object('supply_request_id',d));
  perform t_ev('5','SUPPLY_REQUEST_DISPATCHED',jsonb_build_object('supply_request_id',d,'runner_name','ר'));
  perform t_ev('4','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',d,'reason','supplied_otherwise'));
  perform t_eq(t_st(d),'cancelled/pc_to_logo/supplied_otherwise','5 chamal cancels dispatched');
  -- 6 PC refused on dispatched even at medic_to_pc; admin in_transit ok
  e := t_req('E'); perform t_ev('5','SUPPLY_REQUEST_DISPATCHED',jsonb_build_object('supply_request_id',e));
  perform t_ev('2','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',e,'reason','not_needed'));
  perform t_eq(t_st(e),'dispatched/medic_to_pc/-','6 pc refused on dispatched');
  perform t_ev('5','SUPPLY_REQUEST_IN_TRANSIT',jsonb_build_object('supply_request_id',e));
  perform t_ev('6','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',e,'reason','other','note','  הכוח עבר אתר  '));
  perform t_eq(t_st(e)||'/'||(select cancel_note from supply_requests where id=e),'cancelled/medic_to_pc/other/הכוח עבר אתר','6 admin cancels in_transit, note trimmed');
  -- 7 refused roles and bad payloads; events still stored
  f := t_req('F');
  perform t_ev('1','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f,'reason','not_needed'));
  perform t_ev('5','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f,'reason','not_needed'));
  perform t_ev('7','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f,'reason','not_needed'));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f,'reason','bogus'));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f,'reason','other','note','   '));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id','not-a-uuid','reason','not_needed'));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('id','F','reason','not_needed'));
  perform t_eq(t_st(f),'requested/medic_to_pc/-','7 refused roles / bad payloads leave row');
  select count(*) into n from events where type='SUPPLY_REQUEST_CANCELLED' and payload_json->>'supply_request_id' is distinct from a::text;
  perform t_eq(n::text,'15','7 every cancel event stored');
  -- 8 delivered not cancellable
  g := t_req('G'); perform t_ev('2','SUPPLY_REQUEST_RECEIVED',jsonb_build_object('supply_request_id',g));
  perform t_ev('3','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',g,'reason','not_needed'));
  perform t_eq(t_st(g),'delivered/medic_to_pc/-','8 delivered not cancellable');
  -- 9 059 behaviour unchanged: approve, escalate, dispatch on a normal request; escalation of delivered blocked (new)
  h := t_req('H'); perform t_ev('2','RESUPPLY_APPROVED_FROM_PC_TRUCK',jsonb_build_object('supply_request_id',h));
  perform t_eq(t_st(h),'approved/medic_to_pc/-','9 approve');
  perform t_ev('5','RESUPPLY_APPROVED_FROM_PC_TRUCK',jsonb_build_object('supply_request_id',f));
  perform t_eq(t_st(f),'requested/medic_to_pc/-','9 logistics approval ignored');
  perform t_ev('2','RESUPPLY_ESCALATED_TO_CC',jsonb_build_object('supply_request_id',g));
  perform t_eq(t_st(g),'delivered/medic_to_pc/-','9 delivered not escalated');
  perform t_ev('2','RESUPPLY_ESCALATED_TO_CC',jsonb_build_object('supply_request_id',f));
  perform t_eq(t_st(f),'requested/pc_to_logo/-','9 escalate');
  -- 10 the refused cross-incident case
  insert into incidents values ('00000000-0000-4000-8000-000000000002');
  insert into events(incident_id,actor_id,device_id,local_event_id,type,payload_json) values ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','dev-3','x','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',f,'reason','not_needed'));
  perform t_eq(t_st(f),'requested/pc_to_logo/-','10 other incident cannot cancel');
  -- 12 WP-38's receipt kept: a medic who is not the requester changes nothing; the requester's own
  --    receipt records what arrived; a cancelled request takes no receipt.
  h := t_req('R');
  perform t_ev('7','SUPPLY_REQUEST_CANCELLED',jsonb_build_object('supply_request_id',h,'reason','not_needed'));
  insert into profiles values ('10000000-0000-4000-8000-000000000008','medic');
  perform t_ev('8','SUPPLY_REQUEST_RECEIVED',jsonb_build_object('supply_request_id',h));
  perform t_eq(t_st(h),'requested/medic_to_pc/-','12 another medic receipt ignored');
  perform t_ev('1','SUPPLY_REQUEST_RECEIVED',jsonb_build_object('supply_request_id',h,'received_items',jsonb_build_array(jsonb_build_object('item','tourniquets','quantity',1))));
  perform t_eq(t_st(h)||'/'||(select (received_by is not null)::text||'/'||jsonb_array_length(received_items_json) from supply_requests where id=h),'delivered/medic_to_pc/-/true/1','12 requester receipt recorded');
  perform t_ev('1','SUPPLY_REQUEST_RECEIVED',jsonb_build_object('supply_request_id',a));
  perform t_eq((select status::text||'/'||coalesce(received_at::text,'-') from supply_requests where id=a),'cancelled/-','12 cancelled takes no receipt');
end $$;
-- 11 direct writes closed for authenticated
set role authenticated; select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',false);
do $$ declare n int; begin
  select count(*) into n from supply_requests; if n = 0 then raise exception 'FAIL 11 read'; end if; raise notice 'ok 11 read still works (% rows)', n;
  begin update supply_requests set status='cancelled'; raise exception 'FAIL 11 update allowed'; exception when insufficient_privilege then raise notice 'ok 11 update refused'; end;
  begin delete from supply_requests; raise exception 'FAIL 11 delete allowed'; exception when insufficient_privilege then raise notice 'ok 11 delete refused'; end;
  begin insert into supply_requests(incident_id,requester_id) values ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'); raise exception 'FAIL 11 insert allowed'; exception when insufficient_privilege then raise notice 'ok 11 insert refused'; end;
end $$;
reset role;
