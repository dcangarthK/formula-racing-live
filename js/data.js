// Public data entry point. The open-source edition intentionally ships only
// the original APEX championship; no real-world team, driver, or sponsor data
// is bundled in this repository.
import {
  SEASON, TEAMS, DRIVERS, CALENDAR, POINTS, REGS_2026,
} from './data-fictional.js';
import { applyTeamProfile, teamProfileStore } from './teamProfile.js';

// The player's own team is written into the grid here, before any consumer
// reads it, so the car livery, timing tower, championship tables and telemetry
// all see one set of records. Without a saved profile this is the shipped
// fictional team unchanged.
applyTeamProfile(teamProfileStore.get(), TEAMS, DRIVERS);

/** Re-applies an edited team profile to the live grid records. */
export function applyPlayerTeamProfile(profile) {
  return applyTeamProfile(profile, TEAMS, DRIVERS);
}

export { SEASON, TEAMS, DRIVERS, CALENDAR, POINTS, REGS_2026 };

// Retained for compatibility with existing APEX championship saves.
export const STORAGE_SUFFIX = '_apex';
