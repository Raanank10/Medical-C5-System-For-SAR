# Roadmap

The project should proceed in two parallel tracks while sharing one event model and one demo story.

## Track 1: Portfolio / Analyst Case Study

Goal: make the repository immediately legible to interviewers for data analyst, product analyst, and analytics engineer roles.

### Next Milestones

- Polish root README with screenshots from the prototype.
- Add a short case-study PDF or Markdown narrative.
- Add a metric lineage diagram from event log to KPI to command decision.
- Add sample SQL queries for each KPI.
- Add screenshots of the generated AAR report.
- Add a small demo video or GIF walkthrough.

### Interview Proof Points

- Product discovery from a real operational gap.
- Workflow design under field constraints.
- Event-sourced data model.
- KPI design and metric definitions.
- Offline-first sync tradeoffs.
- Dashboard and AAR analytics.

## Track 2: PC MVP Demonstration

Goal: show a realistic enough workflow that a Platoon Commander can evaluate operational value.

### Next Milestones

- Freeze one scripted demo scenario.
- Add seeded patients matching that script.
- Make command view easier to access during the demo.
- Add a clear "PC Demo Mode" entry point.
- Add fake/simulated sync status and freshness indicators.
- Add a simple AAR screen or export link from the demo.

### MVP Proof Points

- Medic can create a patient quickly.
- PC can see patient counts and locations.
- Alerts surface overdue vitals, deterioration, and tourniquet concerns.
- Handover and site-clear status are visible.
- AAR story is understandable after the event.

## Later Build Options

- Split the prototype into a React/Expo app and React command dashboard.
- Add local SQLite persistence.
- Add Supabase/Postgres backend.
- Implement `/sync/log` push/pull API.
- Add role-based authentication and RLS.
- Add command-state worker and realtime outbox.
- Add QR handover tokens.
- Add automated test data generation.

## Guiding Constraint

Do not let production architecture slow down demo learning too early. The next useful version should be judged by whether an interviewer or PC understands the problem, trusts the workflow, and can ask sharper questions after seeing it.
