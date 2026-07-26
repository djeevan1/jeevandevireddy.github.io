# Event Sync Service

A complete dependency-free Node.js full-stack application that ingests CRM and calendar JSON files, reconciles records representing the same real-world meeting, exposes a validated REST API, and presents a responsive browser UI with conflict, warning, match-score, and field-provenance visibility.

## Run locally

Prerequisite: **Node.js 18 or newer**.

```bash
npm start
```

Open **http://localhost:3000**. No `npm install` is required because runtime and tests use only Node.js built-ins.

Optional configuration:

```bash
PORT=8080 npm start
DATA_DIR=/absolute/path/to/data npm start
```

The data directory must contain `crm_events.json` and `calendar_events.json`.


### API troubleshooting

Start the application from the project root and keep that terminal running:

```bash
npm start
```

Then verify the server directly:

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/meetings
```

Do not open `public/index.html` directly with a `file://` URL. Use `http://localhost:3000`, because the Node server hosts both the frontend and API. If the frontend is hosted separately, set the `api-base` meta value in `public/index.html` to the backend URL, such as `http://localhost:3000`. Browser CORS and OPTIONS preflight are supported.

The meetings response exposes both `data` and `meetings` arrays for client compatibility.

## Test and validate

```bash
npm test
npm run check
```

The suite covers malformed dates, reconciliation, duplicate clustering, conflicts, source-only records, health, filtering, sorting, pagination, detail lookup, diagnostics, structured errors, and reload behavior.

## REST API

### Service endpoints

- `GET /api/health` — status, version, uptime, source-generation time, and reload count
- `GET /api/summary` — reconciliation totals and filter facets
- `GET /api/diagnostics` — flattened conflicts, warnings, match decisions, and unmatched records
- `POST /api/reload` — atomically reload both source files and recompute the cache

### Meeting endpoints

- `GET /api/meetings` — paginated reconciled meetings
- `GET /api/meetings/:id` — detail by unified ID (`meeting-001`) or source ID (`CRM-1001`, `CAL-A1`)

Supported query parameters:

| Parameter | Values / behavior |
|---|---|
| `q` | Free-text search across business fields, attendee values, and source IDs |
| `source` | `crm` or `calendar` |
| `conflicts` | `true` or `false` |
| `warnings` | `true` or `false` |
| `status` | Exact normalized status |
| `owner` | Case-insensitive owner substring |
| `from`, `to` | Inclusive `YYYY-MM-DD` range |
| `sort` | `date`, `title`, `owner`, `company`, `status`, or `conflicts` |
| `order` | `asc` or `desc` |
| `page` | Positive integer |
| `limit` | 1–100; default 20 |

Example:

```bash
curl "http://localhost:3000/api/meetings?q=meridian&source=crm&conflicts=true&sort=date&order=asc&page=1&limit=10"
```

Successful list responses contain `data`, global `summary`, `facets`, applied `filters`, and `pagination`. Validation failures use a consistent shape:

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "limit must be an integer between 1 and 100",
    "requestId": "..."
  }
}
```

## Reconciliation approach

Each source record is normalized to a common shape. Normalization handles missing values, status casing, attendee-derived client names, organizer-derived owners, company inference from attendee domains, malformed attendee values, timezone-aware timestamps, timezone-less timestamps, and the malformed CRM date `03-15/2025`. Data-quality warnings stay attached to the unified meeting.

Candidate cross-source matches must occur on the same calendar date. An explainable score evaluates:

- exact, nearby, or common US Eastern timezone-adjusted time
- title-token similarity
- client/company identity in names, titles, and attendee emails
- relationship-owner / organizer agreement
- location similarity

A score of **65 or greater** is accepted. IDs are never used as matching evidence. After a CRM-to-calendar match is selected, another calendar record joins only when it strongly matches both members, handling the supplied Pinnacle duplicate without globally collapsing ordinary nearby calendar events.

Every accepted decision is retained under `matchMetadata` with its score and reasons.

## Conflict and merge policy

No disagreement is hidden. Each merged field retains all contributing values under `provenance`; distinct normalized values produce a conflict.

Unified presentation defaults are:

- CRM for title, client, company, owner, location, notes, type, status, date, and start time
- Calendar for end time, attendees, and recurrence
- fallback to any available source when the preferred source is missing

This policy changes only the displayed value. It never deletes originals.

## Frontend functionality

The browser UI includes:

- service-health and reload state
- global reconciliation summary cards
- free-text, source, status, owner, date-range, conflict, and warning filters
- sorting, ordering, and page-size controls
- server-side pagination
- source, conflict, and warning badges
- attendees and full business fields
- match scores and reasons
- conflict comparison rows
- field-level provenance
- responsive mobile layout and user-visible API errors

## Project structure

```text
src/reconcile.js       normalization, scoring, clustering, facets, diagnostics, provenance
src/server.js          validated REST API, health/reload, errors, logging, static-file server
public/index.html      responsive application shell
public/app.js          API state, filters, pagination, rendering, reload and errors
public/styles.css      responsive UI styling
data/                  supplied CRM and calendar JSON files
test/                  unit and HTTP integration tests
docs/AI_COLLABORATION.md
```

## Production considerations

This assessment intentionally stays dependency-free and in-memory for one-command reliability. A production implementation should add durable storage, source adapters/webhooks, JSON-schema validation, authentication and authorization, configurable timezone/business-calendar rules, manual match overrides, immutable audit history, rate limiting, telemetry, distributed locking for reloads, cursor pagination, and background ingestion.

## Assumptions

- CRM dates represent the intended business-local calendar date.
- A cross-source meeting does not move across calendar dates.
- Organizer local-parts map reasonably to relationship-owner names.
- Common four- and five-hour US Eastern offsets are evaluated for matching only.
- Original timestamps are retained in source provenance; the service does not assert an unsupported unified timezone.


## Port setup

### Recommended: one port
Run `npm start` and open `http://localhost:3000`. The Node server serves both the frontend and all `/api/*` endpoints on the same port. Do not start a second frontend server.

### Optional: Live Server / separate frontend
If the HTML is served from common development ports such as `5500` or `5173`, the frontend automatically calls the backend at `http://localhost:3000`. Start the backend first with `npm start`.

### API checks
- `http://localhost:3000/api/health`
- `http://localhost:3000/api/meetings`
- `http://localhost:3000/api/meetings?q=meridian`

The UI includes a Search button. Pressing Enter in the search field also runs the search.


## Filter behavior

Status and Owner dropdowns use normalized exact matching. Their option counts are context-aware: each dropdown is recalculated using all other active filters, so displayed counts match the records that can be returned.
