import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAndReconcile, defaultDataDir } from './reconcile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const dataDir = process.env.DATA_DIR || defaultDataDir;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const startedAt = new Date().toISOString();
const allowedOrigin = process.env.CORS_ORIGIN || '*';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

let cache = await loadAndReconcile(dataDir);
let lastReloadAt = cache.generatedAt;
let reloadCount = 0;

const commonHeaders = requestId => ({
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, x-requested-with',
  'access-control-expose-headers': 'x-request-id',
  'x-request-id': requestId
});

const jsonHeaders = requestId => ({
  ...commonHeaders(requestId),
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
});

function sendJson(res, status, body, requestId, extraHeaders = {}) {
  res.writeHead(status, { ...jsonHeaders(requestId), ...extraHeaders });
  res.end(JSON.stringify(body, null, 2));
}

function apiError(res, status, code, message, requestId, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}), requestId } }, requestId);
}

function parseBoolean(value, name) {
  if (value == null || value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new QueryError(`${name} must be true or false`);
}

function parsePositiveInt(value, fallback, max, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new QueryError(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function validateDate(value, name) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new QueryError(`${name} must use YYYY-MM-DD format`);
  }
  return value;
}

class QueryError extends Error {}

function textForMeeting(meeting) {
  return [
    meeting.title, meeting.date, meeting.startTime, meeting.endTime, meeting.clientName,
    meeting.company, meeting.owner, meeting.type, meeting.location, meeting.notes,
    meeting.status, ...(meeting.attendees || []),
    ...meeting.sources.flatMap(source => [source.source, source.id])
  ].filter(Boolean).join(' ').toLowerCase();
}

function normalizeFilterValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function countFacet(meetings, getter) {
  const labels = new Map();
  for (const meeting of meetings) {
    const raw = getter(meeting);
    if (raw === null || raw === undefined || raw === '') continue;
    const label = String(raw).trim().replace(/\s+/g, ' ');
    const key = normalizeFilterValue(label);
    const current = labels.get(key) || { value: key, label, count: 0 };
    current.count += 1;
    labels.set(key, current);
  }
  return [...labels.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function meetingMatches(meeting, filters, excluded = null) {
  const { q, source, conflicts, warnings, status, owner, from, to } = filters;
  if (excluded !== 'q' && q && !textForMeeting(meeting).includes(q)) return false;
  if (excluded !== 'source' && source && !meeting.sources.some(item => item.source === source)) return false;
  if (excluded !== 'conflicts' && conflicts !== null && Boolean(meeting.conflicts.length) !== conflicts) return false;
  if (excluded !== 'warnings' && warnings !== null && Boolean(meeting.warnings.length) !== warnings) return false;
  if (excluded !== 'status' && status && normalizeFilterValue(meeting.status) !== status) return false;
  if (excluded !== 'owner' && owner && normalizeFilterValue(meeting.owner) !== owner) return false;
  if (excluded !== 'from' && from && (!meeting.date || meeting.date < from)) return false;
  if (excluded !== 'to' && to && (!meeting.date || meeting.date > to)) return false;
  return true;
}

function queryMeetings(url) {
  const allowed = new Set(['q', 'source', 'conflicts', 'warnings', 'status', 'owner', 'from', 'to', 'sort', 'order', 'page', 'limit']);
  const unknown = [...url.searchParams.keys()].filter(key => !allowed.has(key));
  if (unknown.length) throw new QueryError(`Unsupported query parameter(s): ${unknown.join(', ')}`);

  const q = normalizeFilterValue(url.searchParams.get('q'));
  const source = normalizeFilterValue(url.searchParams.get('source'));
  const status = normalizeFilterValue(url.searchParams.get('status'));
  const owner = normalizeFilterValue(url.searchParams.get('owner'));
  const conflicts = parseBoolean(url.searchParams.get('conflicts'), 'conflicts');
  const warnings = parseBoolean(url.searchParams.get('warnings'), 'warnings');
  const from = validateDate(url.searchParams.get('from'), 'from');
  const to = validateDate(url.searchParams.get('to'), 'to');
  if (from && to && from > to) throw new QueryError('from must be on or before to');
  if (source && !['crm', 'calendar'].includes(source)) throw new QueryError('source must be crm or calendar');

  const sort = url.searchParams.get('sort') || 'date';
  const order = url.searchParams.get('order') || 'asc';
  if (!['date', 'title', 'owner', 'company', 'status', 'conflicts'].includes(sort)) throw new QueryError('Invalid sort field');
  if (!['asc', 'desc'].includes(order)) throw new QueryError('order must be asc or desc');

  const page = parsePositiveInt(url.searchParams.get('page'), 1, 100000, 'page');
  const limit = parsePositiveInt(url.searchParams.get('limit'), 20, 100, 'limit');
  const filters = { q, source, conflicts, warnings, status, owner, from, to, sort, order };

  // Each dropdown is calculated with every active filter except itself. This keeps
  // option counts aligned with the records that can actually be returned.
  const facets = {
    statuses: countFacet(cache.meetings.filter(meeting => meetingMatches(meeting, filters, 'status')), meeting => meeting.status),
    owners: countFacet(cache.meetings.filter(meeting => meetingMatches(meeting, filters, 'owner')), meeting => meeting.owner)
  };

  let meetings = cache.meetings.filter(meeting => meetingMatches(meeting, filters));
  const compare = (left, right) => {
    const values = {
      date: meeting => `${meeting.date || '9999-99-99'}T${meeting.startTime || '99:99'}`,
      title: meeting => meeting.title || '',
      owner: meeting => meeting.owner || '',
      company: meeting => meeting.company || '',
      status: meeting => meeting.status || '',
      conflicts: meeting => meeting.conflicts.length
    };
    const a = values[sort](left);
    const b = values[sort](right);
    const result = typeof a === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
    return order === 'desc' ? -result : result;
  };
  meetings.sort(compare);

  const total = meetings.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;
  meetings = meetings.slice(offset, offset + limit);

  return {
    data: meetings,
    facets,
    pagination: { page: safePage, requestedPage: page, limit, total, totalPages, hasNext: safePage < totalPages, hasPrevious: safePage > 1 },
    filters: { ...filters, source: source || null, status: status || null, owner: owner || null }
  };
}

function createEtag(body) {
  return `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
}

async function serveStatic(url, req, res, requestId) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.resolve(publicDir, `.${requested}`);
  if (!(file === publicDir || file.startsWith(`${publicDir}${path.sep}`))) {
    return apiError(res, 403, 'FORBIDDEN', 'Forbidden', requestId);
  }
  const body = await fs.readFile(file);
  const etag = createEtag(body);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'x-request-id': requestId });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': mime[path.extname(file)] || 'application/octet-stream',
    'cache-control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300',
    etag,
    ...commonHeaders(requestId),
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    res.on('finish', () => {
      const elapsed = Math.round((performance.now() - started) * 10) / 10;
      console.log(`${new Date().toISOString()} ${requestId} ${req.method} ${req.url} ${res.statusCode} ${elapsed}ms`);
    });

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (url.pathname.startsWith('/api/') && req.method === 'OPTIONS') {
        res.writeHead(204, { ...commonHeaders(requestId), allow: 'GET, POST, OPTIONS' });
        return res.end();
      }

      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET', requestId);
        return sendJson(res, 200, {
          status: 'ok', service: 'event-sync-service', version: '4.1.0', startedAt,
          generatedAt: cache.generatedAt, lastReloadAt, reloadCount,
          uptimeSeconds: Math.floor(process.uptime()), dataDirectory: path.basename(dataDir)
        }, requestId);
      }

      if (url.pathname === '/api/summary') {
        if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET', requestId);
        return sendJson(res, 200, { generatedAt: cache.generatedAt, summary: cache.summary, facets: cache.facets }, requestId);
      }

      if (url.pathname === '/api/diagnostics') {
        if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET', requestId);
        return sendJson(res, 200, { generatedAt: cache.generatedAt, diagnostics: cache.diagnostics }, requestId);
      }

      if (url.pathname === '/api/reload') {
        if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST', requestId);
        const next = await loadAndReconcile(dataDir);
        cache = next;
        reloadCount += 1;
        lastReloadAt = new Date().toISOString();
        return sendJson(res, 200, { message: 'Data reloaded successfully', generatedAt: cache.generatedAt, summary: cache.summary }, requestId);
      }

      if (url.pathname === '/api/meetings') {
        if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET', requestId);
        const result = queryMeetings(url);
        return sendJson(res, 200, {
          generatedAt: cache.generatedAt,
          summary: cache.summary,
          ...result,
          // Keep both names for compatibility with the original contract and newer clients.
          meetings: result.data
        }, requestId);
      }

      const detailMatch = url.pathname.match(/^\/api\/meetings\/([^/]+)$/);
      if (detailMatch) {
        if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET', requestId);
        const id = decodeURIComponent(detailMatch[1]);
        const meeting = cache.meetings.find(item => item.id === id || item.sources.some(source => source.id === id));
        if (!meeting) return apiError(res, 404, 'MEETING_NOT_FOUND', `No meeting found for ${id}`, requestId);
        return sendJson(res, 200, { data: meeting }, requestId);
      }

      if (url.pathname.startsWith('/api/')) return apiError(res, 404, 'ROUTE_NOT_FOUND', 'API route not found', requestId);
      if (!['GET', 'HEAD'].includes(req.method)) return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Static assets support GET and HEAD', requestId);
      return serveStatic(url, req, res, requestId);
    } catch (error) {
      if (error instanceof QueryError) return apiError(res, 400, 'INVALID_QUERY', error.message, requestId);
      if (error.code === 'ENOENT') return apiError(res, 404, 'NOT_FOUND', 'Not found', requestId);
      if (error instanceof URIError) return apiError(res, 400, 'INVALID_PATH', 'Malformed URL path', requestId);
      console.error(error);
      return apiError(res, 500, 'INTERNAL_ERROR', 'Internal server error', requestId);
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  createServer().listen(port, host, () => console.log(`Event Sync Service running at http://localhost:${port}`));
}
