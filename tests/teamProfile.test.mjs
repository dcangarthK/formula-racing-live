import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TEAM_PROFILE,
  applyTeamProfile,
  createTeamProfileStore,
  entrantName,
  normalizeCode,
  normalizeColor,
  normalizeNumber,
  normalizeTeamProfile,
  toHex,
} from '../js/teamProfile.js';

function grid() {
  return {
    teams: [
      { id: 'apexnine', name: 'Apex Nine', fullName: 'Apex Nine Racing', code: 'APX', color: 0x111C2E, accent: 0x16C7FF, perf: 0.97 },
      { id: 'vantara', name: 'Vantara', fullName: 'Vantara Racing Collective', color: 0x7B2FF7, accent: 0xFFD200, perf: 0.99 },
    ],
    drivers: [
      { id: 'castellane', code: 'CAS', num: 26, firstName: 'Ruben', lastName: 'Castellane', team: 'apexnine' },
      { id: 'marchetti', code: 'MAR', num: 7, firstName: 'Ines', lastName: 'Marchetti', team: 'apexnine' },
      { id: 'nyholm', code: 'NYH', num: 2, firstName: 'Kasper', lastName: 'Nyholm', team: 'vantara' },
    ],
  };
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    size: () => map.size,
  };
}

test('normalizes player input into a usable team identity', () => {
  const profile = normalizeTeamProfile({
    teamName: '   Kubayi   Racing   ', teamCode: 'kbyx', color: '#ff8800', accent: 'f0f',
    driverFirstName: 'Duncan', driverLastName: 'Kubayi', driverCode: '', driverNumber: '44',
  });
  assert.equal(profile.teamName, 'Kubayi Racing');
  assert.equal(profile.teamFullName, 'Kubayi Racing');
  assert.equal(profile.teamCode, 'KBY');
  assert.equal(profile.color, 0xFF8800);
  assert.equal(profile.accent, 0xFF00FF);
  assert.equal(profile.driverCode, 'KUB', 'an empty abbreviation falls back to the surname');
  assert.equal(profile.driverNumber, 44);
});

test('falls back to the shipped identity for unusable values', () => {
  const profile = normalizeTeamProfile({
    teamName: '   ', teamCode: '7', color: 'not-a-colour', accent: null,
    driverFirstName: '', driverLastName: '   ', driverNumber: 0,
  });
  assert.deepEqual(
    { ...profile, custom: false },
    { ...DEFAULT_TEAM_PROFILE, custom: false },
  );
  assert.equal(normalizeCode('a', 'APX'), 'APX', 'one letter is not an abbreviation');
  assert.equal(normalizeCode('ab', 'APX'), 'ABX', 'two letters are padded');
  assert.equal(normalizeColor('#abc', 0), 0xAABBCC);
  assert.equal(toHex(0x16C7FF), '#16c7ff');
  assert.equal(normalizeNumber(120, [], 26), 26);
  assert.equal(normalizeNumber(-1, [], 26), 26);
});

test('keeps car numbers unique on the grid', () => {
  assert.equal(normalizeNumber(7, [7, 2], 26), 26, 'a number another driver carries is refused');
  assert.equal(normalizeNumber(44, [7, 2], 26), 44);
});

test('names an entrant without repeating the word racing', () => {
  assert.equal(entrantName('Lombard'), 'Lombard Racing');
  assert.equal(entrantName('Lombard Racing'), 'Lombard Racing');
  assert.equal(entrantName('Kubayi Motorsport'), 'Kubayi Motorsport');
});

test('writes the profile into the live grid records', () => {
  const { teams, drivers } = grid();
  const result = applyTeamProfile({
    teamName: 'Kubayi', teamCode: 'KBY', color: '#ff8800', accent: '#001122',
    driverFirstName: 'Duncan', driverLastName: 'Kubayi', driverNumber: 44,
  }, teams, drivers);

  assert.equal(result.team, teams[0], 'the shared record is mutated, not replaced');
  assert.equal(teams[0].name, 'Kubayi');
  assert.equal(teams[0].fullName, 'Kubayi Racing');
  assert.equal(teams[0].color, 0xFF8800);
  assert.equal(teams[0].perf, 0.97, 'performance is never edited, so grid balance holds');
  assert.equal(drivers[0].lastName, 'Kubayi');
  assert.equal(drivers[0].num, 44);
  assert.equal(drivers[1].num, 7, 'the team-mate is untouched');
  assert.equal(teams[1].name, 'Vantara', 'other constructors are untouched');
});

test('refuses a car number the rest of the grid already uses', () => {
  const { teams, drivers } = grid();
  applyTeamProfile({ teamName: 'Kubayi', driverNumber: 2 }, teams, drivers);
  assert.equal(drivers[0].num, 26);
});

test('persists a saved profile and restores the default on reset', () => {
  const storage = memoryStorage();
  const store = createTeamProfileStore({ storage });
  assert.equal(store.get().custom, false);

  const saved = store.save({ teamName: 'Kubayi', driverNumber: 44 });
  assert.equal(saved.custom, true);
  assert.equal(saved.teamName, 'Kubayi');
  assert.equal(createTeamProfileStore({ storage }).get().teamName, 'Kubayi', 'survives a reload');

  store.reset();
  assert.equal(storage.size(), 0);
  assert.equal(createTeamProfileStore({ storage }).get().teamName, DEFAULT_TEAM_PROFILE.teamName);
});

test('re-derives the entrant name when the team is renamed', () => {
  const store = createTeamProfileStore({ storage: memoryStorage() });
  assert.equal(store.save({ teamName: 'Kubayi' }).teamFullName, 'Kubayi Racing');
  assert.equal(store.save({ teamName: 'Vantara' }).teamFullName, 'Vantara Racing');
  assert.equal(store.save({ teamFullName: 'Vantara Works Team' }).teamFullName, 'Vantara Works Team',
    'an explicit entrant name is kept');
});

test('works when storage is unavailable', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  const store = createTeamProfileStore({ storage: blocked });
  assert.equal(store.get().teamName, DEFAULT_TEAM_PROFILE.teamName);
  assert.equal(store.save({ teamName: 'Kubayi' }).teamName, 'Kubayi', 'the session still gets its team');
});
