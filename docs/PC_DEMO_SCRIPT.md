# PC Demo Script

Purpose: show a Platoon Commander how C5 Sentinel-SAR reduces operational fog during a SAR medical incident.

Recommended length: 7-10 minutes.

## Demo Setup

Open `index.html` in a browser. Use a mobile-sized browser window first, then switch to the commander view inside the prototype.

Suggested framing:

> "This is not trying to replace doctrine or radio. It is a second layer of operational memory: every patient, every timer, every handover, and every alert in one shared picture."

## Storyline

### 1. Start With The Field Problem

Ask the PC:

- How many casualties are in the building right now?
- Which are red?
- Which floor are they on?
- Who has a tourniquet running?
- Which medic has not reported recently?
- What has already been handed over?

Then explain: the app is designed so those answers are created as a byproduct of the medic workflow.

### 2. Medic Opens Or Joins An Incident

Show the incident/site screen.

Emphasize:

- works in Hebrew RTL
- optimized for fast field capture
- no dependency on network before the medic continues working
- draft incident support exists for zero-command-connectivity moments

### 3. Register A Patient

Create a new patient and move quickly:

- location
- access status
- tourniquet if relevant
- vitals
- triage
- injury/status
- treatment

Explain the design principle: the medic is not "writing a report"; they are doing the field action and the system records the operational state.

### 4. Show Time-Critical Watchdogs

Point to:

- reassessment timer
- deterioration indicator
- tourniquet context
- Golden Hour / crush-risk concept from the spec
- Dead Man's Switch concept for silent medics

Message:

> "The PC does not need to remember every timer manually. The system watches the clocks."

### 5. Switch To Command View

Show:

- total patients by triage
- active alerts
- site tabs
- patient rows
- external reports
- commander-level picture

Message:

> "This answers the question that started the project: how many casualties do we have, where are they, and what needs command attention right now?"

### 6. End With AAR

Explain that every action is an event, so after the incident the system can produce:

- timeline
- triage overrides
- time to first vitals
- reassessment compliance
- handover timing
- supply usage
- command notes

Show the analytics package if time allows.

## MVP Success Criteria

For a real MVP demo, success is not "production-ready." Success is whether a PC says:

- "I understand the field problem this solves."
- "I can see how this would help me command."
- "The medic workflow is fast enough to be believable."
- "The dashboard gives me a better picture than radio memory alone."
- "I can name what would need to change before field testing."

## Questions To Ask The PC

- Which screen would you want first during an event?
- Which alert would be most useful and which would be noise?
- Who should be allowed to approve a draft incident?
- What information would you need before confirming site clear?
- Would medics realistically enter this amount of data under pressure?
- What should be visible to PC but hidden from medics?
- What would make this unacceptable operationally?

## Boundaries

Be explicit:

- prototype only
- no real patient-identifiable data
- not a certified medical device
- not replacing MDA, doctrine, radio, or command procedure
- meant to explore workflow, data capture, and command visibility
