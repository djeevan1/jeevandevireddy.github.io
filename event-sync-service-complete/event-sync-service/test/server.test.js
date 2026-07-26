import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { createServer } = await import('../src/server.js');

async function withServer(run) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('health and summary endpoints return operational metadata', async () => withServer(async base => {
  const health = await fetch(`${base}/api/health`).then(response => response.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.version, '4.1.0');
  const summary = await fetch(`${base}/api/summary`).then(response => response.json());
  assert.equal(summary.summary.input.crm, 20);
  assert.ok(summary.facets.statuses);
}));

test('meetings endpoint filters, sorts, and paginates', async () => withServer(async base => {
  const response = await fetch(`${base}/api/meetings?q=meridian&source=crm&sort=title&order=asc&page=1&limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.pagination.limit, 1);
  assert.ok(body.pagination.total >= 1);
  assert.ok(JSON.stringify(body.data[0]).toLowerCase().includes('meridian'));
}));

test('meeting detail supports source identifiers', async () => withServer(async base => {
  const response = await fetch(`${base}/api/meetings/CRM-1001`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.data.sources.some(source => source.id === 'CAL-A1'));
}));

test('invalid queries and missing meetings use structured errors', async () => withServer(async base => {
  const invalid = await fetch(`${base}/api/meetings?limit=1000`);
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, 'INVALID_QUERY');
  assert.ok(invalidBody.error.requestId);

  const missing = await fetch(`${base}/api/meetings/not-real`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'MEETING_NOT_FOUND');
}));

test('diagnostics and reload endpoints are functional', async () => withServer(async base => {
  const diagnostics = await fetch(`${base}/api/diagnostics`).then(response => response.json());
  assert.ok(diagnostics.diagnostics.conflicts.length > 0);
  assert.ok(diagnostics.diagnostics.matches.length > 0);
  const reload = await fetch(`${base}/api/reload`, { method: 'POST' });
  assert.equal(reload.status, 200);
  assert.equal((await reload.json()).message, 'Data reloaded successfully');
}));



test('meetings response preserves legacy meetings property', async () => withServer(async base => {
  const response = await fetch(`${base}/api/meetings`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.meetings, body.data);
  assert.ok(Array.isArray(body.meetings));
}));

test('API supports browser CORS and preflight', async () => withServer(async base => {
  const getResponse = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(getResponse.headers.get('access-control-allow-origin'), '*');
  const optionsResponse = await fetch(`${base}/api/meetings`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(optionsResponse.status, 204);
  assert.match(optionsResponse.headers.get('access-control-allow-methods'), /GET/);
}));

test('status and owner filters use exact normalized option values', async () => withServer(async base => {
  const exactResponse = await fetch(`${base}/api/meetings?owner=%20JAMES%20%20WU%20`);
  const exactBody = await exactResponse.json();
  assert.equal(exactResponse.status, 200);
  assert.equal(exactBody.pagination.total, 9);
  assert.ok(exactBody.data.every(meeting => meeting.owner === 'James Wu'));

  const partialResponse = await fetch(`${base}/api/meetings?owner=james`);
  const partialBody = await partialResponse.json();
  assert.equal(partialResponse.status, 200);
  assert.equal(partialBody.pagination.total, 0);

  const statusResponse = await fetch(`${base}/api/meetings?status=CONFIRMED&owner=james%20wu`);
  const statusBody = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.ok(statusBody.data.every(meeting => meeting.status === 'confirmed' && meeting.owner === 'James Wu'));
}));

test('status and owner facets reflect the other active filters', async () => withServer(async base => {
  const response = await fetch(`${base}/api/meetings?owner=james%20wu`);
  const body = await response.json();
  assert.equal(response.status, 200);
  const statusCounts = Object.fromEntries(body.facets.statuses.map(item => [item.value, item.count]));
  assert.deepEqual(statusCounts, { confirmed: 6, scheduled: 1, tentative: 2 });

  const confirmed = await fetch(`${base}/api/meetings?status=confirmed`).then(response => response.json());
  const ownerCounts = Object.fromEntries(confirmed.facets.owners.map(item => [item.value, item.count]));
  assert.deepEqual(ownerCounts, { 'james wu': 6, 'sarah chen': 11 });
}));
