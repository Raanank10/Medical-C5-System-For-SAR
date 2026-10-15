# Synthetic Scenarios (scenario injector)

Option B for field experiments: `scripts/inject_scenario.js` signs in as **virtual medics** and pushes a scripted, synthetic MCI timeline into a real incident through the real `/sync/log` Edge Function, the same path a phone uses. PC/CC/Chamal screens see the incident unfold live. Option A (real people playing medics) works at the same time in the same incident.

**Synthetic data only** (`docs/OPERATIONS_SAFETY.md`). Every scenario must declare `"synthetic": true`. The clinical values here are plausible but synthetic and are not doctrine; review them per `docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md` before an exercise.

## Scenarios

| File | What |
|---|---|
| `small_site_alpha_v1.json` | One collapsed building, 2 virtual medics, 9 casualties over ~20 minutes, plus 5 injects (`deterioration`, `medic_silent`, `medic_back`, `mass_arrival`, `overdue_tourniquet`). Built for the first PC+CC experiment. |

The 26-patient / 3-site rehearsal (`analytics/c5_sentinel_sar_analytics_v1_1/seed_mci_rehearsal_scenario_v1.py`) still only seeds SQLite; converting it to this format is the next step.

## One-time setup: virtual medic accounts

Use dedicated synthetic accounts, never a real person's account. An admin with the service-role key creates them once (the key never goes into the repo or a command line argument):

```bash
SUPABASE_SERVICE_ROLE_KEY=... node scripts/invite_user.js <synthetic-address-1> medic "Virtual Medic 1"
SUPABASE_SERVICE_ROLE_KEY=... node scripts/invite_user.js <synthetic-address-2> medic "Virtual Medic 2"
```

Complete each invite (set a password), then create an accounts file **outside the repo** (`*.accounts.json` is git-ignored as a safety net):

```json
{
  "vm1": { "email": "<synthetic-address-1>", "password": "..." },
  "vm2": { "email": "<synthetic-address-2>", "password": "..." }
}
```

The keys (`vm1`, `vm2`) must match the scenario's `actors`. The injector refuses accounts whose role is not `medic` or `paramedic`.

## Running

```bash
# Validate a scenario and print its timeline (no network)
node scripts/inject_scenario.js --scenario scenarios/small_site_alpha_v1.json --dry-run

# A virtual medic opens a DRAFT incident (tests the command approval banner), the other joins
node scripts/inject_scenario.js --scenario scenarios/small_site_alpha_v1.json --accounts ~/c5/vm.accounts.json --open-draft

# Or inject into an incident that already exists (e.g. one a real medic or the PC opened)
node scripts/inject_scenario.js --scenario scenarios/small_site_alpha_v1.json --accounts ~/c5/vm.accounts.json --join <incident_id>
```

While it runs, type an inject name to fire it now (`deterioration`, `mass_arrival`, ...), or `list`, `status`, `quit`. Injects can also be pre-scheduled for reproducible runs: `--inject deterioration@8:30`. `--speed 10` runs the clock 10x faster for a dry rehearsal. Re-running into the **same** incident needs `--visual-prefix R2-`, because patient visual ids are unique per incident.

## How injected data is told apart

Every injected event carries `payload_json.synthetic_source = 'injector'` plus `scenario_id` and `run_id`, and comes from a device id starting with `injector-`. Participants never see this. For the AAR, filter on it to separate human activity from injected activity. The incident-lifecycle events written by `open_incident()`/`join_incident()` themselves are not tagged (those RPCs take no payload); the opener's device id still identifies them.

## Scenario format

`timeline` steps run at `at` (`m:ss` from start). Inject `steps` run at `after` (`m:ss` from when the inject fires). Actions:

| action | fields | sync events sent |
|---|---|---|
| `create` | `patient`, `triage` (red/yellow/green/black), optional `trap_status`, `vitals` | `QUICK_PATIENT_CREATED`, then `PATIENT_TRIAGE_UPDATED` (or `PATIENT_TRIAGED_EXPECTANT` for black), `PATIENT_ACCESS_UPDATED`, `VITALS_RECORDED` |
| `vitals` | `patient`, `vitals` {pulse, rr, spo2, avpu, bp_estimate}, optional `triage` | `VITALS_RECORDED` (+ `PATIENT_TRIAGE_UPDATED`) |
| `triage` | `patient`, `triage` | `PATIENT_TRIAGE_UPDATED` |
| `access` | `patient`, `trap_status` | `PATIENT_ACCESS_UPDATED` |
| `tourniquet` | `patient`, `limb` (right_arm/left_arm/right_leg/left_leg), optional `clinical_context`, `applied_offset_minutes` | `TOURNIQUET_APPLIED` |
| `status` | `patient`, `status` | `PATIENT_STATUS_UPDATED` |
| `handover` | `patient`, optional `receiving_unit_transport`, `destination_facility` | `PATIENT_HANDED_OVER` |
| `expectant` | `patient` | `PATIENT_TRIAGED_EXPECTANT` |
| `silence` / `resume` | actor only | stops / restarts that virtual medic's heartbeats (Dead Man's Switch) |
| `note` | `note` | nothing; printed on the operator console |

The validator checks actors, patient order (no event before its patient is created), value vocabularies (the same keys `index.html` uses), plausible vital ranges, and the live `tourniquets_clinical_context_check` constraint (a value outside it makes the server reject the whole event).

## Verification done

- Offline harness: `node scripts/test_inject_scenario.js` runs the real injector process against a local mock of every endpoint it calls and checks the traffic (tags, ordering, actor separation, heartbeats, injects).
- Live payload check: all 62 events of `small_site_alpha_v1` (timeline + every inject) were replayed against the live database as a real medic account inside a rolled-back transaction. Projection results: triage, status, trap status, handovers, the expectant patient and both tourniquets all landed as scripted; the command snapshot read 5 active red of 13.
- Not yet done: an end-to-end run with real virtual-medic accounts (needs the accounts above).

## Known gap this surfaced (not fixed here)

The real field app (`index.html`) never sends `PATIENT_TRIAGE_UPDATED`; red/yellow/green triage reaches the server only for black (`PATIENT_TRIAGED_EXPECTANT`). Server-side `current_triage` stays `pending` for human-created patients, so CC/PC counts and other devices show them untriaged. The injector sends triage explicitly, so injected patients are correct, which means injected and human patients currently behave differently. Tracked as a separate triage-sync fix (triage changes need their own careful review per `CLAUDE.md`).
