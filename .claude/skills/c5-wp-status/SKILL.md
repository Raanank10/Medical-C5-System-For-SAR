---
name: c5-wp-status
description: Report the status of C5 Sentinel-SAR work packages (WP-N) from docs/GAP_CLOSURE_PLAN.md and src/domain/event-contract.json, separating what the plan claims from what is verified live. Use when asked what is done, open, blocked or next, about a specific WP, or before starting a WP.
---

# Work package status in C5 Sentinel-SAR

`docs/GAP_CLOSURE_PLAN.md` is the plan and its status table is the repo's claim. A claim is not a verification. Every answer keeps three levels apart:

1. **Plan says done**: the status table or WP section says so.
2. **Done in code**: the code and its browser test exist on `main`, and the event types left `known_gaps`.
3. **Verified live**: the plan records a live check (objects probed, two-phone run, rolled-back RLS check) with a date, or you ran one now, read-only.

## Steps

1. Read from a fresh `main`, not from memory or earlier conversations. Note the commit and `APP_VERSION`:

   ```bash
   git log -1 --format='%h %cd'
   grep -n "const APP_VERSION" index.html
   ```

2. Read the plan's "Status" table (near the end) and, for each WP asked about, its own section (`### WP-N:`). Read the "Decisions the owner must make" table for decisions a WP still waits on, and "Order" under round 2 for what comes next.
3. Cross-check the event contract. A WP is not finished while it still has entries in `known_gaps`:

   ```bash
   python3 -c "import json; g=json.load(open('src/domain/event-contract.json'))['known_gaps']; [print(wp, len(t), ', '.join(t)) for wp, t in g.items()]"
   ```

4. For items marked done whose live state matters, offer a read-only check through the Supabase connector (probe the objects the WP's migrations create). Do not write anything. WP-35 tracks which files are applied live; many were applied in the SQL editor and have no migration row.
5. Note items moved to later WPs (for example WP-0 part 2 to WP-21) instead of reporting them as done.

## Output

A short table: WP, what the plan says, done in code (yes/partly/no, with the evidence), verified live (date and how, or "not verified"), open decision or blocker. Then the next WP by the plan's order, and anything the owner must answer first. Cite the file and line or query for every claim, and say plainly where the plan and the code disagree.
