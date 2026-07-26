import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAndReconcile, defaultDataDir, normalizeCrm } from '../src/reconcile.js';

test('normalizes malformed CRM date and records warning',()=>{const x=normalizeCrm({crm_id:'x',meeting_date:'03-15/2025'});assert.equal(x.date,'2025-03-15');assert.match(x.warnings[0],/malformed/)});

test('reconciles known cross-source records and same-source duplicate',async()=>{const result=await loadAndReconcile(defaultDataDir);const meridian=result.meetings.find(m=>m.sources.some(s=>s.id==='CRM-1001'));assert.ok(meridian.sources.some(s=>s.id==='CAL-A1'));const pinnacle=result.meetings.find(m=>m.sources.some(s=>s.id==='CRM-1005'));assert.deepEqual(new Set(pinnacle.sources.map(s=>s.id)),new Set(['CRM-1005','CAL-A5','CAL-A6']));});

test('surfaces conflicts and preserves source-only records',async()=>{const result=await loadAndReconcile(defaultDataDir);const summit=result.meetings.find(m=>m.sources.some(s=>s.id==='CRM-1002'));assert.ok(summit.conflicts.some(c=>c.field==='location'));assert.ok(result.meetings.some(m=>m.sources.length===1));assert.equal(result.summary.input.crm,20);assert.equal(result.summary.input.calendar,22);});
