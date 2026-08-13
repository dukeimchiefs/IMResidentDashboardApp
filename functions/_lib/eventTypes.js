// Single source of truth mapping QR-payload prefixes -> DB values -> display labels.
// NOTE: scripts/generate_qr.py mirrors QR_PREFIXES as a plain Python list since it
// can't import this module directly. Adding a new event type means updating both.
export const EVENT_TYPES = {
  noon: { dbValue: 'noon_conference', label: 'Noon Conference' },
  learning: { dbValue: 'learning_session', label: 'Learning Session' },
  grandrounds: { dbValue: 'grand_rounds', label: 'Medicine Grand Rounds' },
};

export const QR_PREFIXES = Object.keys(EVENT_TYPES); // ['noon', 'learning', 'grandrounds']

// Lecture QRs rotate once a week rather than daily. The token is HMAC'd against
// the Saturday that opens the week (see weekAnchor in token.js), so one code
// stays valid Sat–Fri and covers the whole Mon–Fri lecture week. This also
// removes the daily race that broke scans: the rotation job now runs on a day
// with no lectures, and a late run still computes the same week's token.
// Must mirror WEEKLY_TYPES in scripts/generate_qr.py.
export const WEEKLY_TYPES = ['noon', 'learning', 'grandrounds'];

// Event types that were retired but still have attendance rows in the database.
// Nothing can be checked into them any more — they are absent from EVENT_TYPES,
// so their QR prefix no longer parses — but /attendance still has to render the
// rows they left behind, and would otherwise print the raw database value.
//
// 'welcome' was a one-per-resident onboarding poster with a QR that never
// expired. It was retired 2026-08-13 with 27 rows recorded; those rows still
// count toward residents' points, so neither they nor this label may be dropped.
// scripts/../scrape_attendance.py likewise still maps 'welcome' for the same reason.
const RETIRED_LABELS = {
  welcome: 'Welcome',
};

export function dbValueToLabel(dbValue) {
  const entry = Object.values(EVENT_TYPES).find((e) => e.dbValue === dbValue);
  return entry ? entry.label : RETIRED_LABELS[dbValue] || dbValue;
}
