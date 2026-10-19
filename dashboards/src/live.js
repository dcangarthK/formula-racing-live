// Live timing screen. It renders a LiveState and nothing else, so it works
// against any serving layer that produces one.

import { createSource, sourceConfig } from './source.js';
import { formatLapTime } from './contract.js';

const config = sourceConfig();
const $ = id => document.getElementById(id);
const TEAM_COLOURS = {}; // filled from the roster as teams appear

// Deterministic colour per team id, so the tower reads the same every run
// without the dashboard needing the game's palette.
function teamColour(teamId) {
  if (!teamId) return '#555';
  if (TEAM_COLOURS[teamId]) return TEAM_COLOURS[teamId];
  let hash = 0;
  for (const char of teamId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  TEAM_COLOURS[teamId] = `hsl(${hash % 360} 70% 55%)`;
  return TEAM_COLOURS[teamId];
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

function gapText(car) {
  if (car.position === 1) return 'LEADER';
  if (car.pitState) return 'PIT';
  if (car.lapsDown > 0) return `+${car.lapsDown}L`;
  return Number.isFinite(car.gapToLeaderSeconds) ? `+${car.gapToLeaderSeconds.toFixed(1)}` : '—';
}

function statusText(car) {
  if (car.dnf) return 'DNF';
  if (car.finished) return 'FIN';
  if (car.pitState) return `<span class="pit">PIT ${escape(car.pitState)}</span>`;
  if (car.penaltySeconds > 0) return `<span class="pen">+${car.penaltySeconds.toFixed(0)}s</span>`;
  return '';
}

function renderTower(state) {
  const tower = $('tower');
  if (!state.cars.length) {
    tower.innerHTML = '<tr><td colspan="10" class="empty">Waiting for the first sample…</td></tr>';
    return;
  }
  tower.innerHTML = state.cars.map(car => `
    <tr class="${car.isPlayer ? 'player' : ''} ${car.dnf ? 'out' : ''}">
      <td class="num">${car.position}</td>
      <td><span class="team-bar" style="background:${teamColour(car.teamId)}"></span><span class="code">${escape(car.code || car.driverId)}</span>
        ${car.lastName ? ` ${escape(car.lastName)}` : ''}</td>
      <td>${escape(car.teamName || car.teamId)}</td>
      <td class="num">${gapText(car)}</td>
      <td class="num">${car.position === 1 || !Number.isFinite(car.intervalSeconds) ? '' : `+${car.intervalSeconds.toFixed(1)}`}</td>
      <td class="num">${formatLapTime(car.lastLapSeconds)}</td>
      <td class="num">${formatLapTime(car.bestLapSeconds)}</td>
      <td><span class="tyre ${escape(car.tyreCompound)}">${escape(car.tyreCompound)}</span></td>
      <td class="num">${Math.round((car.tyreWearFraction || 0) * 100)}%</td>
      <td>${statusText(car)}</td>
    </tr>`).join('');
}

function traceRow(label, value, fraction, extraClass = '') {
  const width = Math.max(0, Math.min(1, fraction || 0)) * 100;
  return `<div class="trace-row">
    <span class="lbl">${label}</span>
    <span class="bar ${extraClass}"><span style="width:${width}%"></span></span>
    <span class="val">${value}</span>
  </div>`;
}

function renderTrace(state) {
  const player = state.player;
  const target = $('trace');
  if (!player) {
    target.innerHTML = '<p class="empty">No engineering feed yet.</p>';
    return;
  }
  target.innerHTML = `
    ${traceRow('Speed', `${Math.round(player.speedKph || 0)} kph`, (player.speedKph || 0) / 360)}
    ${traceRow('Throttle', `${Math.round((player.throttle || 0) * 100)}%`, player.throttle)}
    ${traceRow('Brake', `${Math.round((player.brake || 0) * 100)}%`, player.brake, 'brake')}
    ${traceRow('Battery', `${Math.round((player.batteryFraction || 0) * 100)}%`, player.batteryFraction)}
    ${traceRow('Fuel', `${Math.round((player.fuelFraction || 0) * 100)}%`, player.fuelFraction)}
    ${traceRow('Tyre wear', `${Math.round((player.tyreWearFraction || 0) * 100)}%`, player.tyreWearFraction, 'wear')}
    <dl class="kv">
      <dt>Gear</dt><dd>${player.gear ?? '—'}</dd>
      <dt>Tyre</dt><dd>${escape(player.tyreCompound || '—')} · ${Math.round(player.tyreTemperatureC || 0)}°C</dd>
      <dt>Lateral</dt><dd>${(player.lateralAccelerationMps2 / 9.81 || 0).toFixed(2)} g</dd>
      <dt>Longitudinal</dt><dd>${(player.longitudinalAccelerationMps2 / 9.81 || 0).toFixed(2)} g</dd>
    </dl>`;
}

function renderFeed(state) {
  const feed = $('feed');
  if (!state.events.length) {
    feed.innerHTML = '<li class="empty">No events yet.</li>';
    return;
  }
  feed.innerHTML = state.events.map(event => `
    <li><span class="t">${formatLapTime(event.simulationTimeSeconds)}</span>${escape(event.label)}</li>
  `).join('');
}

function renderStatus(state) {
  const player = state.cars.find(car => car.isPlayer);
  const lap = player ? Math.max(0, player.lap + 1) : 0;
  $('s-session').textContent = state.sessionType.replace('_', ' ');
  $('s-circuit').textContent = state.circuit?.name || state.circuit?.id || '—';
  $('s-lap').textContent = state.configuredLaps ? `${lap}/${state.configuredLaps}` : String(lap || '—');
  $('s-time').textContent = formatLapTime(state.raceTimeSeconds);
  $('s-seq').textContent = String(state.lastSequence + 1);

  const flagState = state.status === 'finished' ? 'finished' : (state.raceControl?.state || 'green');
  const flag = $('s-flag');
  flag.className = `flag ${flagState}`;
  flag.textContent = flagState.replace('-', ' ').toUpperCase();

  const wetness = state.conditions?.wetness || 0;
  $('s-track').textContent = wetness >= 0.15 ? `WET ${Math.round(wetness * 100)}%` : 'DRY';

  const link = $('post-race-link');
  if (state.sessionId) link.href = `post-race.html${location.search || '?'}${location.search ? '&' : ''}session=${encodeURIComponent(state.sessionId)}`;
}

// Glass-to-glass: the serving layer stamps `servedAt`, the page stamps now.
// This is the number the demo is judged on, so it is on screen, not in a log.
function renderLatency(state) {
  const element = $('s-latency');
  if (!state.servedAt) { element.textContent = '—'; return; }
  const ms = Date.now() - state.servedAt;
  element.textContent = `${ms} ms`;
  element.className = `val ${ms < 1000 ? 'good' : ms < 2000 ? 'warn' : 'bad'}`;
}

function render(state) {
  renderStatus(state);
  renderLatency(state);
  renderTower(state);
  renderTrace(state);
  renderFeed(state);
}

function fail(message) {
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="error">${escape(message)}</p>`);
}

async function start() {
  const source = await createSource(config);
  $('source-label').textContent = `source ${source.kind} · ${source.describe()}`;

  let sessionId = config.sessionId;
  if (!sessionId) {
    const sessions = await source.listSessions();
    if (!sessions.length) return fail('No sessions available from this source yet.');
    // Prefer a race in progress; otherwise show the most recent one.
    sessionId = (sessions.find(session => session.status === 'running') || sessions[0]).sessionId;
  }
  source.subscribeLive(sessionId, render, error => fail(error.message));
}

start().catch(error => fail(`Could not start: ${error.message}`));
