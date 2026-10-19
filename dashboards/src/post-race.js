// Post-race analysis screen. It renders a RaceReport, so any serving layer
// that can produce one — from BigQuery, Firestore, a file in GCS — works here.

import { createSource, sourceConfig } from './source.js';
import { formatLapTime } from './contract.js';

const config = sourceConfig();
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

function renderHeadline(report) {
  const player = report.player;
  $('r-circuit').textContent = report.circuit?.name || report.circuit?.id || '—';
  $('r-type').textContent = report.sessionType.replace('_', ' ');
  $('r-status').textContent = report.status;
  $('r-laps').textContent = String(report.completedLaps || player?.laps || 0);
  $('r-best').textContent = formatLapTime(player?.bestLapSeconds);
  $('r-avg').textContent = formatLapTime(player?.averageLapSeconds);
  const consistency = $('r-consistency');
  const value = player?.consistency ?? 0;
  consistency.textContent = player ? `${Math.round(value * 100)}%` : '—';
  consistency.className = `val ${value > 0.9 ? 'good' : value > 0.75 ? 'warn' : 'bad'}`;
}

function renderClassification(report) {
  const body = $('classification');
  if (!report.classification.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">This session was ${escape(report.status)}; no classification was issued.</td></tr>`;
    return;
  }
  body.innerHTML = report.classification.map(entry => `
    <tr class="${entry.isPlayer ? 'player' : ''} ${entry.status === 'DNF' ? 'out' : ''}">
      <td class="num">${entry.position}</td>
      <td><span class="code">${escape(entry.code || entry.driverId)}</span> ${escape(entry.lastName || '')}</td>
      <td>${escape(entry.teamName || entry.teamId)}</td>
      <td class="num">${entry.laps ?? ''}</td>
      <td class="num">${formatLapTime(entry.bestLapSeconds)}</td>
      <td class="num">${entry.penaltySeconds ? `+${entry.penaltySeconds}s` : ''}</td>
      <td class="num">${entry.points || ''}</td>
      <td>${escape(entry.status || '')}</td>
    </tr>`).join('');
}

function renderLaps(report) {
  const body = $('laps');
  const laps = report.player?.lapTimes || [];
  if (!laps.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No laps recorded.</td></tr>';
    $('lap-chart').innerHTML = '';
    return;
  }
  const best = Math.min(...laps.map(lap => lap.lapTimeSeconds));
  // Per-sector personal bests, which is what a driver actually looks at.
  const bestSectors = [0, 1, 2].map(index => Math.min(
    ...laps.map(lap => lap.sectorsSeconds?.[index]).filter(value => Number.isFinite(value) && value > 0),
  ));
  body.innerHTML = laps.map(lap => `
    <tr class="${lap.lapTimeSeconds === best ? 'player' : ''}">
      <td class="num">${lap.lapNumber}</td>
      <td class="num">${formatLapTime(lap.lapTimeSeconds)}</td>
      ${[0, 1, 2].map(index => {
        const value = lap.sectorsSeconds?.[index];
        const isBest = Number.isFinite(value) && value === bestSectors[index];
        return `<td class="num ${isBest ? 'sector-best' : ''}">${formatLapTime(value)}</td>`;
      }).join('')}
      <td class="num">${lap.lapTimeSeconds === best ? '—' : `+${(lap.lapTimeSeconds - best).toFixed(3)}`}</td>
    </tr>`).join('');
  renderChart(laps, best);
}

function renderChart(laps, best) {
  const times = laps.map(lap => lap.lapTimeSeconds);
  const max = Math.max(...times);
  const min = Math.min(...times);
  const span = Math.max(0.5, max - min);
  const x = index => 40 + (index / Math.max(1, laps.length - 1)) * 740;
  const y = time => 170 - ((time - min) / span) * 140;

  const gridLines = [0, 0.5, 1].map(fraction => {
    const value = min + span * fraction;
    return `<line class="grid" x1="40" x2="780" y1="${y(value)}" y2="${y(value)}"></line>
            <text x="2" y="${y(value) + 3}">${formatLapTime(value)}</text>`;
  }).join('');

  const path = laps.map((lap, index) => `${index ? 'L' : 'M'}${x(index)},${y(lap.lapTimeSeconds)}`).join(' ');
  const dots = laps.map((lap, index) =>
    `<circle class="${lap.lapTimeSeconds === best ? 'best' : 'dot'}" cx="${x(index)}" cy="${y(lap.lapTimeSeconds)}" r="3"></circle>
     <text x="${x(index) - 4}" y="186">${lap.lapNumber}</text>`).join('');

  $('lap-chart').innerHTML = `${gridLines}<path class="line" d="${path}"></path>${dots}`;
}

function renderDebrief(report) {
  const target = $('debrief');
  const debrief = report.debrief;
  if (!debrief) {
    target.innerHTML = `<p class="empty">No AI debrief on this session. A team that builds the
      race-engineer layer writes it into <code>debrief</code> on this report.</p>`;
    return;
  }
  const list = items => (items || []).map(item =>
    `<li>${escape(typeof item === 'string' ? item : item.recommendation || item.issue || JSON.stringify(item))}</li>`).join('');
  target.innerHTML = `
    ${debrief.summary ? `<p>${escape(debrief.summary)}</p>` : ''}
    ${debrief.strengths?.length ? `<h3>Strengths</h3><ul class="feed">${list(debrief.strengths)}</ul>` : ''}
    ${debrief.improvementAreas?.length ? `<h3>Where the time went</h3><ul class="feed">${list(debrief.improvementAreas)}</ul>` : ''}`;
}

function renderEvents(report) {
  const feed = $('events');
  if (!report.events.length) { feed.innerHTML = '<li class="empty">No events.</li>'; return; }
  feed.innerHTML = report.events.map(event =>
    `<li><span class="t">${formatLapTime(event.simulationTimeSeconds)}</span>${escape(event.label)}</li>`).join('');
}

function fail(message) {
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="error">${escape(message)}</p>`);
}

async function start() {
  const source = await createSource(config);
  $('source-label').textContent = `source ${source.kind} · ${source.describe()}`;

  const sessions = await source.listSessions().catch(() => []);
  const picker = $('session-picker');
  picker.innerHTML = sessions.map(session =>
    `<option value="${escape(session.sessionId)}">${escape(session.circuit?.name || session.circuit?.id || session.sessionId)} · ${escape(session.sessionType)}</option>`).join('');

  const show = async (sessionId) => {
    const report = await source.getRace(sessionId);
    renderHeadline(report);
    renderClassification(report);
    renderLaps(report);
    renderDebrief(report);
    renderEvents(report);
  };

  const initial = config.sessionId || sessions[0]?.sessionId;
  if (!initial) return fail('No finished sessions available from this source yet.');
  picker.value = initial;
  picker.addEventListener('change', () => show(picker.value).catch(error => fail(error.message)));
  await show(initial);
}

start().catch(error => fail(`Could not load the race: ${error.message}`));
