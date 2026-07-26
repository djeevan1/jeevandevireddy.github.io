const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
const state = { page: 1, data: null, controller: null };
const configuredApiBase = document.querySelector('meta[name="api-base"]')?.content?.trim().replace(/\/$/, '') || '';
const isLikelyStandaloneFrontend = ['5500', '5173', '5174', '8080'].includes(window.location.port);
const API_BASE = configuredApiBase || (isLikelyStandaloneFrontend ? 'http://localhost:3000' : '');
const apiUrl = path => `${API_BASE}${path}`;

function showNotice(message, kind = 'info') {
  const node = $('#notice');
  node.textContent = message;
  node.className = `notice ${kind}`;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => node.classList.add('hidden'), 4500);
}

async function fetchJson(url, options) {
  const response = await fetch(apiUrl(url), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}

function paramsFromControls() {
  const params = new URLSearchParams({
    page: String(state.page), limit: $('#limit').value, sort: $('#sort').value, order: $('#order').value
  });
  const values = [['q','#search'],['source','#source'],['status','#status'],['owner','#owner'],['from','#from'],['to','#to']];
  for (const [key, selector] of values) if ($(selector).value) params.set(key, $(selector).value);
  if ($('#conflicts').checked) params.set('conflicts', 'true');
  if ($('#warnings').checked) params.set('warnings', 'true');
  return params;
}

async function checkHealth() {
  try {
    const health = await fetchJson('/api/health');
    $('#health').textContent = `● Healthy · ${health.version}`;
    $('#health').classList.add('ok');
  } catch (error) {
    $('#health').textContent = '● Service unavailable';
    $('#health').classList.add('bad');
    showNotice(`API unavailable at ${apiUrl('/api/health')}. Start the backend with npm start.`, 'error');
  }
}

async function load() {
  state.controller?.abort();
  state.controller = new AbortController();
  $('#meetings').innerHTML = '<div class="loading">Loading reconciled meetings…</div>';
  try {
    state.data = await fetchJson(`/api/meetings?${paramsFromControls()}`, { signal: state.controller.signal });
    state.page = state.data.pagination.page;
    render();
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('#meetings').innerHTML = `<div class="empty error">${esc(error.message)}</div>`;
  }
}

function hydrateFacetSelect(selector, values, current) {
  const node = $(selector);
  const first = node.options[0].outerHTML;
  const options = Array.isArray(values)
    ? values
    : Object.entries(values || {}).map(([label, count]) => ({ value: label.toLowerCase(), label, count }));
  node.innerHTML = first + options.map(option =>
    `<option value="${esc(option.value)}">${esc(option.label)} (${option.count})</option>`
  ).join('');
  node.value = current;
  // Preserve a valid active filter even if a future API implementation omits it.
  if (current && node.value !== current) {
    node.insertAdjacentHTML('beforeend', `<option value="${esc(current)}">${esc(current)}</option>`);
    node.value = current;
  }
}

function renderStats(summary) {
  const stats = [
    ['Unified', summary.unifiedMeetings], ['Matched', summary.matchedMeetings],
    ['Source-only', summary.sourceOnlyMeetings], ['With conflicts', summary.meetingsWithConflicts],
    ['Warnings', summary.dataWarnings], ['CRM input', summary.input.crm], ['Calendar input', summary.input.calendar]
  ];
  $('#stats').innerHTML = stats.map(([label,value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
}

function render() {
  const { data: meetings, summary, facets, pagination } = state.data;
  renderStats(summary);
  hydrateFacetSelect('#status', facets.statuses, $('#status').value);
  hydrateFacetSelect('#owner', facets.owners, $('#owner').value);
  $('#resultText').textContent = `${pagination.total} result${pagination.total === 1 ? '' : 's'} · generated ${new Date(state.data.generatedAt).toLocaleString()}`;
  $('#pageText').textContent = `Page ${pagination.page} of ${pagination.totalPages}`;
  $('#previous').disabled = !pagination.hasPrevious;
  $('#next').disabled = !pagination.hasNext;

  const root = $('#meetings');
  root.innerHTML = '';
  if (!meetings.length) {
    root.innerHTML = '<div class="empty">No meetings match the current filters.</div>';
    return;
  }

  for (const meeting of meetings) {
    const node = $('#card').content.cloneNode(true);
    node.querySelector('h3').textContent = meeting.title;
    node.querySelector('.date').textContent = `${meeting.date || 'Unknown date'} · ${meeting.startTime || 'Time TBD'}${meeting.endTime ? `–${meeting.endTime}` : ''}`;
    node.querySelector('.ids').textContent = meeting.sources.map(source => source.id).join(' · ');
    const sourceBadges = [...new Set(meeting.sources.map(source => source.source))].map(source => `<span class="badge ${source}">${esc(source)}</span>`).join('');
    const issueBadges = `${meeting.conflicts.length ? `<span class="badge conflict">${meeting.conflicts.length} conflict${meeting.conflicts.length > 1 ? 's' : ''}</span>` : ''}${meeting.warnings.length ? `<span class="badge warning">${meeting.warnings.length} warning${meeting.warnings.length > 1 ? 's' : ''}</span>` : ''}`;
    node.querySelector('.badges').innerHTML = sourceBadges + issueBadges;

    const fields = [
      ['Client', meeting.clientName], ['Company', meeting.company], ['Owner', meeting.owner],
      ['Location', meeting.location], ['Type', meeting.type], ['Status', meeting.status],
      ['Recurring', meeting.recurring === null ? '—' : meeting.recurring ? 'Yes' : 'No'],
      ['Attendees', meeting.attendees?.join(', ')], ['Notes', meeting.notes]
    ];
    node.querySelector('.details').innerHTML = fields.map(([label,value]) => `<div class="field"><b>${label}</b><span>${esc(value)}</span></div>`).join('');
    node.querySelector('.warning-list').innerHTML = meeting.warnings.map(warning => `<p>⚠ ${esc(warning.source)} ${esc(warning.sourceId)}: ${esc(warning.message)}</p>`).join('');

    const matching = meeting.matchMetadata.length ? `<section><h4>Match decisions</h4>${meeting.matchMetadata.map(match => `<div class="match-row"><strong>${esc(match.left)} ↔ ${esc(match.right)}</strong><span>Score ${match.score}</span><p>${esc(match.reasons.join(', '))}</p></div>`).join('')}</section>` : '';
    const conflicts = meeting.conflicts.length ? `<section><h4>Conflicts</h4>${meeting.conflicts.map(conflict => `<div class="conflict-row"><b>${esc(conflict.field)}</b>${conflict.values.map(value => `<div>${esc(value.source)} (${esc(value.sourceId)}): ${esc(Array.isArray(value.value) ? value.value.join(', ') : value.value)}</div>`).join('')}</div>`).join('')}</section>` : '';
    const provenance = `<section><h4>Field provenance</h4>${Object.entries(meeting.provenance).filter(([,values]) => values.length).map(([field,values]) => `<div class="source-line"><b>${esc(field)}:</b> ${values.map(value => `${esc(value.source)}:${esc(value.sourceId)} = ${esc(Array.isArray(value.value) ? value.value.join(', ') : value.value)}`).join(' | ')}</div>`).join('')}</section>`;
    node.querySelector('.provenance').innerHTML = matching + conflicts + provenance;
    root.append(node);
  }
}

function resetPageAndLoad() { state.page = 1; load(); }
let timer;
$('#search').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(resetPageAndLoad, 500);
});
$('#searchForm').addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(timer);
  resetPageAndLoad();
});
for (const selector of ['#source','#status','#owner','#from','#to','#sort','#order','#limit','#conflicts','#warnings']) $(selector).addEventListener('change', resetPageAndLoad);
$('#previous').addEventListener('click', () => { state.page -= 1; load(); window.scrollTo({ top: 300, behavior: 'smooth' }); });
$('#next').addEventListener('click', () => { state.page += 1; load(); window.scrollTo({ top: 300, behavior: 'smooth' }); });
$('#clear').addEventListener('click', () => {
  for (const selector of ['#search','#source','#status','#owner','#from','#to']) $(selector).value = '';
  $('#sort').value = 'date'; $('#order').value = 'asc'; $('#limit').value = '20';
  $('#conflicts').checked = false; $('#warnings').checked = false;
  resetPageAndLoad();
});
$('#reload').addEventListener('click', async () => {
  const button = $('#reload'); button.disabled = true; button.textContent = 'Reloading…';
  try { const result = await fetchJson('/api/reload', { method: 'POST' }); showNotice(`${result.message}. ${result.summary.unifiedMeetings} meetings available.`, 'success'); await load(); }
  catch (error) { showNotice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'Reload source data'; }
});

checkHealth();
load();
