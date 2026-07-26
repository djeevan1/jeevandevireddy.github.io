import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INTERNAL_DOMAIN = 'firma.com';
const STOP_WORDS = new Set(['meeting','discussion','review','call','session','update','q1','q2','q3','q4','the','and','with','for','annual','quick']);

const clean = value => typeof value === 'string' ? value.trim() || null : value ?? null;
const normalizeText = value => (clean(value) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const titleTokens = value => new Set(normalizeText(value).split(' ').filter(t => t.length > 2 && !STOP_WORDS.has(t)));
const intersectionSize = (a,b) => [...a].filter(x => b.has(x)).length;
const jaccard = (a,b) => !a.size && !b.size ? 0 : intersectionSize(a,b) / new Set([...a,...b]).size;
const titleCase = emailPart => emailPart.split(/[._-]/).map(s => s ? s[0].toUpperCase()+s.slice(1) : '').join(' ');
const normalizeStatus = value => clean(value)?.toLowerCase() || null;

function parseDateFlexible(value) {
  if (!value) return { value: null, warning: 'missing date' };
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (iso.test(value)) return { value, warning: null };
  const malformed = value.match(/^(\d{2})-(\d{2})\/(\d{4})$/);
  if (malformed) return { value: `${malformed[3]}-${malformed[1]}-${malformed[2]}`, warning: `normalized malformed date ${value}` };
  return { value: null, warning: `unparseable date ${value}` };
}

function parseDateTime(value) {
  if (!value || typeof value !== 'string') return { date: null, time: null, epoch: null, warning: 'missing datetime' };
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return { date: null, time: null, epoch: null, warning: `unparseable datetime ${value}` };
  const epoch = Date.parse(value.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return { date: match[1], time: match[2], epoch: Number.isNaN(epoch) ? null : epoch, warning: null, timezoneExplicit: Boolean(match[3]) };
}

function minutes(time) {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [h,m] = time.split(':').map(Number);
  return h*60+m;
}

function externalAttendees(attendees=[]) {
  return attendees.filter(a => typeof a === 'string' && a.includes('@') && !a.toLowerCase().endsWith(`@${INTERNAL_DOMAIN}`));
}

function attendeeNames(attendees=[]) {
  return externalAttendees(attendees).map(email => titleCase(email.split('@')[0]));
}

function organizerName(email) {
  return email?.includes('@') ? titleCase(email.split('@')[0]) : clean(email);
}

function deriveCompany(attendees=[]) {
  const external = externalAttendees(attendees)[0];
  if (!external) return null;
  const domain = external.split('@')[1]?.split('.')[0] || '';
  return titleCase(domain.replace(/(cap|adv|gp|vc|wp|inst|hold)$/i, ' $1'));
}

export function normalizeCrm(record) {
  const parsedDate = parseDateFlexible(record.meeting_date);
  const warnings = [parsedDate.warning].filter(Boolean);
  if (!record.meeting_time) warnings.push('missing meeting time');
  return {
    source: 'crm', sourceId: record.crm_id, raw: record,
    title: clean(record.subject), date: parsedDate.value, time: clean(record.meeting_time), endTime: null,
    clientName: clean(record.client_name), company: clean(record.client_company), owner: clean(record.relationship_owner),
    type: clean(record.meeting_type), location: clean(record.location), notes: clean(record.notes),
    status: normalizeStatus(record.status), attendees: [], recurring: null, warnings
  };
}

export function normalizeCalendar(record) {
  const start = parseDateTime(record.start_time);
  const end = parseDateTime(record.end_time);
  const warnings = [start.warning, end.warning].filter(Boolean);
  const malformedAttendees = (record.attendees || []).filter(a => typeof a !== 'string' || (!a.includes('@') && a !== 'external-guests'));
  if (malformedAttendees.length) warnings.push(`malformed attendee values: ${malformedAttendees.join(', ')}`);
  return {
    source: 'calendar', sourceId: record.event_id, raw: record,
    title: clean(record.title), date: start.date, time: start.time, endTime: end.time,
    clientName: attendeeNames(record.attendees)[0] || null, company: deriveCompany(record.attendees), owner: organizerName(record.organizer),
    type: record.location && /zoom|teams|virtual/i.test(record.location) ? 'Virtual' : null,
    location: clean(record.location), notes: clean(record.description), status: normalizeStatus(record.status),
    attendees: Array.isArray(record.attendees) ? record.attendees : [], recurring: Boolean(record.is_recurring), warnings,
    timezoneExplicit: start.timezoneExplicit
  };
}

function identityScore(a,b) {
  let score = 0;
  const reasons = [];
  const sameDate = a.date && b.date && a.date === b.date;
  if (sameDate) { score += 35; reasons.push('same date'); }
  else return { score: -100, reasons: ['different dates'] };

  const aTime = minutes(a.time), bTime = minutes(b.time);
  if (aTime != null && bTime != null) {
    const raw = Math.abs(aTime-bTime);
    const adjusted = Math.min(raw, Math.abs(raw-240), Math.abs(raw-300));
    if (adjusted <= 15) { score += 25; reasons.push(raw === adjusted ? 'same time' : 'timezone-adjusted time'); }
    else if (adjusted <= 60) { score += 12; reasons.push('nearby time'); }
    else if (adjusted <= 180) { score += 2; reasons.push('same-day time differs'); }
    else score -= 15;
  } else { score += 4; reasons.push('time unavailable'); }

  const titleSim = jaccard(titleTokens(a.title), titleTokens(b.title));
  score += Math.round(titleSim*20);
  if (titleSim >= .25) reasons.push('similar title');

  const hayA = normalizeText([a.clientName,a.company,a.title].filter(Boolean).join(' '));
  const hayB = normalizeText([b.clientName,b.company,b.title, ...(b.attendees||[])].filter(Boolean).join(' '));
  const strongTerms = [a.clientName,a.company,b.clientName,b.company].filter(Boolean).map(normalizeText).filter(x => x.length > 3);
  const identityMatch = strongTerms.some(term => hayA.includes(term) && hayB.includes(term));
  if (identityMatch) { score += 30; reasons.push('client/company identity'); }

  if (a.owner && b.owner && normalizeText(a.owner) === normalizeText(b.owner)) { score += 8; reasons.push('same owner'); }
  const locA = normalizeText(a.location), locB = normalizeText(b.location);
  if (locA && locB && (locA.includes(locB) || locB.includes(locA))) { score += 5; reasons.push('similar location'); }
  return { score, reasons };
}

function mergeField(records, field, preferredSource='crm') {
  const values = records.map(r => ({ source:r.source, sourceId:r.sourceId, value:r[field] })).filter(x => x.value !== null && x.value !== '' && x.value !== undefined);
  const distinct = [...new Map(values.map(x => [normalizeText(Array.isArray(x.value)?x.value.join('|'):String(x.value)), x])).values()];
  const preferred = values.find(x => x.source === preferredSource) || values[0] || null;
  return { value: preferred?.value ?? null, provenance: values, conflict: distinct.length > 1 };
}

function mergeCluster(records, index, matchMetadata=[]) {
  const fields = ['title','date','time','endTime','clientName','company','owner','type','location','notes','status','attendees','recurring'];
  const merged = Object.fromEntries(fields.map(field => [field, mergeField(records, field, field === 'endTime' || field === 'attendees' || field === 'recurring' ? 'calendar' : 'crm')]));
  const sourceIds = records.map(r => ({source:r.source,id:r.sourceId}));
  const conflicts = fields.filter(f => merged[f].conflict).map(field => ({ field, values: merged[field].provenance }));
  const warnings = records.flatMap(r => r.warnings.map(message => ({source:r.source,sourceId:r.sourceId,message})));
  return {
    id: `meeting-${String(index+1).padStart(3,'0')}`,
    title: merged.title.value || 'Untitled meeting',
    date: merged.date.value, startTime: merged.time.value, endTime: merged.endTime.value,
    clientName: merged.clientName.value, company: merged.company.value, owner: merged.owner.value,
    type: merged.type.value, location: merged.location.value, notes: merged.notes.value,
    status: merged.status.value, attendees: merged.attendees.value || [], recurring: merged.recurring.value,
    sources: sourceIds, provenance: Object.fromEntries(fields.map(f => [f, merged[f].provenance])),
    conflicts, warnings, matchMetadata
  };
}


function buildFacets(meetings) {
  const countBy = getter => Object.fromEntries([...meetings.reduce((map, meeting) => {
    const value = getter(meeting);
    if (value !== null && value !== undefined && value !== '') map.set(String(value), (map.get(String(value)) || 0) + 1);
    return map;
  }, new Map())].sort((a,b) => a[0].localeCompare(b[0])));
  return {
    sources: countBy(meeting => [...new Set(meeting.sources.map(source => source.source))].sort().join('+')),
    statuses: countBy(meeting => meeting.status),
    owners: countBy(meeting => meeting.owner),
    companies: countBy(meeting => meeting.company),
    dates: countBy(meeting => meeting.date)
  };
}

function buildDiagnostics(meetings) {
  return {
    conflicts: meetings.flatMap(meeting => meeting.conflicts.map(conflict => ({ meetingId: meeting.id, title: meeting.title, ...conflict }))),
    warnings: meetings.flatMap(meeting => meeting.warnings.map(warning => ({ meetingId: meeting.id, title: meeting.title, ...warning }))),
    matches: meetings.flatMap(meeting => meeting.matchMetadata.map(match => ({ meetingId: meeting.id, title: meeting.title, ...match }))),
    unmatched: meetings.filter(meeting => meeting.sources.length === 1).map(meeting => ({ meetingId: meeting.id, title: meeting.title, source: meeting.sources[0] }))
  };
}

export function reconcile(crmRecords, calendarRecords) {
  const crm = crmRecords.map(normalizeCrm);
  const cal = calendarRecords.map(normalizeCalendar);
  const used = new Set();
  const clusters = [];

  for (const c of crm) {
    const candidates = cal.filter(x => !used.has(x.sourceId)).map(x => ({record:x,...identityScore(c,x)})).sort((a,b)=>b.score-a.score);
    const best = candidates[0];
    const cluster = [c];
    const metadata = [];
    if (best && best.score >= 65) {
      cluster.push(best.record); used.add(best.record.sourceId);
      metadata.push({left:c.sourceId,right:best.record.sourceId,score:best.score,reasons:best.reasons});
      // Fold likely same-source calendar duplicates into this real-world meeting.
      for (const extra of cal.filter(x => !used.has(x.sourceId))) {
        const againstCrm = identityScore(c,extra);
        const againstBest = identityScore(best.record,extra);
        if (againstCrm.score >= 70 && againstBest.score >= 65) {
          cluster.push(extra); used.add(extra.sourceId);
          metadata.push({left:best.record.sourceId,right:extra.sourceId,score:againstBest.score,reasons:[...againstBest.reasons,'same-source duplicate candidate']});
        }
      }
    }
    clusters.push({records:cluster,metadata});
  }
  for (const item of cal.filter(x => !used.has(x.sourceId))) clusters.push({records:[item],metadata:[]});

  const meetings = clusters.map((c,i)=>mergeCluster(c.records,i,c.metadata)).sort((a,b)=>`${a.date||'9999'}T${a.startTime||'99:99'}`.localeCompare(`${b.date||'9999'}T${b.startTime||'99:99'}`));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      input: { crm: crm.length, calendar: cal.length },
      unifiedMeetings: meetings.length,
      matchedMeetings: meetings.filter(m=>new Set(m.sources.map(s=>s.source)).size>1).length,
      sourceOnlyMeetings: meetings.filter(m=>m.sources.length===1).length,
      meetingsWithConflicts: meetings.filter(m=>m.conflicts.length).length,
      dataWarnings: meetings.reduce((n,m)=>n+m.warnings.length,0)
    },
    facets: buildFacets(meetings),
    diagnostics: buildDiagnostics(meetings),
    meetings
  };
}

export async function loadAndReconcile(dataDir) {
  const [crm,calendar] = await Promise.all([
    fs.readFile(path.join(dataDir,'crm_events.json'),'utf8').then(JSON.parse),
    fs.readFile(path.join(dataDir,'calendar_events.json'),'utf8').then(JSON.parse)
  ]);
  return reconcile(crm,calendar);
}

export const defaultDataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
