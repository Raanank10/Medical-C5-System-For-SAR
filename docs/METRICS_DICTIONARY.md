# Metrics Dictionary

This document defines the analytics layer for C5 Sentinel-SAR as a product/data analyst case study.

## North Star

**Operational visibility under pressure**

The system should help command know the current casualty picture, the time-critical risks, and the mission bottlenecks faster than radio/paper-only workflows.

## Clinical Metrics

### Total Active Patients

Count of patients in the incident excluding closed/read-only records.

Used by: PC, CC, Chamal.

### Active Red Patients

Count of active patients currently triaged red.

Decision use: critical load, medic allocation, evacuation priority.

### Time To First Vitals

Elapsed minutes between patient creation and first `VITALS_RECORDED` event.

Target in demo analytics: 5 minutes.

Decision use: identifies patients registered but not yet clinically assessed.

### Missing Full Assessment

Patients marked `needs_full_assessment` or missing a full vitals record.

Decision use: supports quick-patient workflow without losing the obligation to complete assessment.

### Vitals Reassessment Compliance

For active red/yellow patients, checks whether the latest vitals are within the reassessment target.

Demo targets:

- Red: 10 minutes
- Yellow: 30 minutes

Decision use: highlights who needs immediate reassessment.

### Golden Hour Compliance

Elapsed time from `t_injury` to handover.

Decision use: command-level patient flow and evacuation pressure.

### Tourniquet Reassessment Due

Active tourniquets where `next_reassessment_due_at` has passed.

Decision use: flags patients needing clinical review.

### High-Risk Clinical Violations

Watchdog/conflict records for high-risk events, such as pediatric medication without weight estimate or negative stock usage.

Decision use: preserves the field action while escalating risk.

## Command Metrics

### Patient Progression Funnel

Tracks movement through:

```text
Identified -> In Treatment -> Extricated -> Handed Over -> Closed / Deceased
```

Decision use: shows bottlenecks in the rescue/evacuation chain.

### Time Registration To Handover

Elapsed minutes from patient creation to handover.

Decision use: evacuation throughput and AAR analysis.

### Medic To Critical Ratio

Active red patients divided by active medics.

Decision use: shows whether command needs to redistribute manpower.

### Dead Man's Switch Events

Alerts for medics/devices that have not heartbeated within the configured window.

Demo target: 5 minutes.

Decision use: PC safety and accountability.

## Logistics Metrics

### Current Inventory

Ledger-based current quantity by item and owner.

Decision use: supports medic kit, platoon stock, and logistics officer view.

### Stockout Risk

Estimates risk level from current quantity and recent burn rate.

Decision use: identifies items that should be dispatched before a field stockout occurs.

### Negative Stock Items

Items with current ledger quantity below zero.

Decision use: preserves out-of-stock treatment documentation while creating a logistics alert.

## Sync And Data Quality Metrics

### Data Freshness

Seconds since last successful sync pull by device.

Demo thresholds:

- Fresh: under 60 seconds
- Stale: over 60 seconds
- Critical stale: over 300 seconds

Decision use: every operational screen should communicate whether the local picture is fresh.

### Sync Latency

Elapsed time between local event timestamp and server timestamp/sync timestamp.

Decision use: evaluates offline-first behavior and network degradation.

### Unsynced Backlog

Events pending delivery from a device.

Decision use: identifies devices whose local state has not reached command.

### Sync Error Summary

Malformed or dependency-blocked events quarantined in `sync_ingestion_errors`.

Decision use: one poison event should not block a whole medic queue.

## Product Interpretation

Good metrics in this system are not vanity metrics. They should answer one of three operational questions:

1. **Who needs action now?**
2. **Where is the mission bottleneck?**
3. **Can command trust the current picture?**
