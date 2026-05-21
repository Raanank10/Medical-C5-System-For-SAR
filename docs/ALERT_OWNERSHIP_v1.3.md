# Alert Ownership and Reinforcement Workflow v1.3

v1.3 separates alert severity from alert ownership. An alert is not useful just because it is red; it is useful when the interface says who must act, what action is required, who needs awareness, and when the alert escalates.

## Alert Object Contract

Every routed alert should carry:

| Field | Purpose |
|---|---|
| `owner` | Primary responsible role: `medic`, `pc`, `cc`, `logistics`, or `chamal`. |
| `audience` | Roles allowed to see the alert. The owner is not always the only viewer. |
| `escalatesTo` | Role that receives escalation if unresolved. |
| `escalateAfterMin` | Minutes until escalation or `null` when escalation is not required. |
| `actionRequired` | Operational action such as `update_vitals`, `assign_medic`, `request_evac`, `request_reinforcement`, or `verify_report`. |
| `scope` | `patient`, `team`, `site`, `company`, or `system`. |
| `category` | UI routing bucket such as `urgent`, `rescue`, `evac`, `data`, `integrity`, or `forces`. |

## Role Routing

Medic alerts focus on direct action: treat, reassess, complete missing rescue-critical fields, and local system status. The medic should not receive company-level command noise.

PC alerts focus on decisions: prioritize red casualties, assign medics, handle trapped patients, coordinate evacuation, resolve duplicate/count uncertainty, and watch stale critical data.

CC alerts are aggregated operational risks: multiple red casualties, evacuation bottlenecks, logistics shortages, silent teams, cross-site report mismatch, and unresolved reinforcement requests.

Chamal alerts focus on data integrity and cross-incident picture quality: sync gaps, external report conflicts, duplicate suspicion, and official incident visibility.

## Commander UI Buckets

The PC/Chamal board routes alerts into:

- `טיפול דחוף`
- `חילוץ / לכודים`
- `פינוי`
- `פערי מידע`
- `אמינות תמונת מצב`
- `חובשים / מכשירים`

Each alert card displays the owner, required action, category, and escalation status.

## Medical Reinforcement Request

v1.3 adds `MEDICAL_REINFORCEMENT_REQUESTED` as a command object, not a generic help button.

Required fields:

| Field | Meaning |
|---|---|
| `resourceType` | `one_medic`, `two_medics`, `paramedic`, `doctor`, `evac_team`, or `medical_equipment`. |
| `reasonCodes` | Structured reasons such as `red_patient`, `tourniquet`, `trapped`, `evac_delay`, or `equipment_shortage`. |
| `urgency` | `immediate`, `high`, or `routine`. |
| `targetLocation` | Site/building/floor or free location. |
| `status` | `pending`, `acknowledged`, `assigned`, `en_route`, `arrived`, `denied`, `cancelled`, or `resolved`. |

The PC creates the request. CC/Chamal can track, acknowledge, assign, and close it. The event export includes both alert ownership rows and reinforcement request state.
