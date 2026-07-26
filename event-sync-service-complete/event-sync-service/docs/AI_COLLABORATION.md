# AI Collaboration Notes

AI assistance was used to brainstorm the reconciliation architecture, enumerate edge cases, scaffold implementation files, and review test scenarios.

## Human-controlled decisions

- Treat reconciliation as explainable scoring rather than exact equality or hidden IDs.
- Preserve raw values through field-level provenance rather than silently overwriting conflicts.
- Normalize the known malformed date format while surfacing a warning.
- Consider 4–5 hour offsets for timezone-aware calendar records because CRM times are local and calendar timestamps are inconsistently zoned.
- Merge a same-source duplicate only when it strongly matches both the CRM record and an already selected calendar match.
- Prefer CRM values for business-facing fields, calendar values for end time, recurrence, and attendee lists.

## AI-generated artifacts reviewed

- Initial server and UI structure
- Matching score categories
- README outline
- Automated test cases

All generated code was executed and tests were run locally before packaging.
