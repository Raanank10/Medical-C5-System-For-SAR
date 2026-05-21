# Changelog v1.3

v1.3 upgrades the command layer from “many alerts” into routed operational work.

## Added

- Alert ownership model with `owner`, `audience`, `escalatesTo`, `escalateAfterMin`, `actionRequired`, and `scope`.
- Commander alert categories: urgent care, rescue/trapped, evacuation, data gaps, picture integrity, and forces/devices.
- Alert cards now show owner, required action, category, and escalation status.
- Medical reinforcement request workflow for PC/CC/Chamal:
  - resource type,
  - reason codes,
  - urgency,
  - location,
  - status tracking.
- Reinforcement request command panel in the PC/Chamal dashboard.
- Exportable `alert_ownership` and `reinforcement_requests` sections in the experiment JSON.

## Changed

- Demo launcher and experiment strip now identify the app as v1.3.
- Medic alerts are grouped around field action: `עכשיו לטפל`, `להשלים כשאפשר`, and system/data alerts.
- PC/Chamal alerts are routed by decision type instead of only critical/routine severity.
- Role authorization matrix now includes medical reinforcement request authority.

## Release Intent

This release is still a development prototype. The purpose is to make the next commander demo clearer: medics treat/reassess, PC prioritizes/assigns/evacuates/verifies, and CC allocates/reinforces/coordinates bottlenecks.
