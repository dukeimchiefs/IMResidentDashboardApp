// Single source of truth mapping QR-payload prefixes -> DB values -> display labels.
// NOTE: scripts/generate_qr.py mirrors QR_PREFIXES as a plain Python list since it
// can't import this module directly. Adding a new event type means updating both.
export const EVENT_TYPES = {
  noon: { dbValue: 'noon_conference', label: 'Noon Conference' },
  learning: { dbValue: 'learning_session', label: 'Learning Session' },
  grandrounds: { dbValue: 'grand_rounds', label: 'Medicine Grand Rounds' },
  welcome: { dbValue: 'welcome', label: 'Welcome' },
};

export const QR_PREFIXES = Object.keys(EVENT_TYPES); // ['noon', 'learning', 'grandrounds', 'welcome']

// Lecture QRs rotate once a week rather than daily. The token is HMAC'd against
// the Saturday that opens the week (see weekAnchor in token.js), so one code
// stays valid Sat–Fri and covers the whole Mon–Fri lecture week. This also
// removes the daily race that broke scans: the rotation job now runs on a day
// with no lectures, and a late run still computes the same week's token.
// Must mirror WEEKLY_TYPES in scripts/generate_qr.py.
export const WEEKLY_TYPES = ['noon', 'learning', 'grandrounds'];

// Event types whose QR is a single static image valid across a multi-day window,
// instead of rotating daily. The token is HMAC'd against anchorDate (not "today"),
// so the same printed/emailed QR keeps working every day in [anchorDate, anchorDate + validDays).
// `validDays: null` means the window never closes — the printed code stays valid
// indefinitely. Safe only for types listed in ONCE_PER_RESIDENT below: with no
// expiry, the per-resident cap is the only thing bounding repeat scans.
// Must mirror MULTI_DAY_WINDOWS in scripts/generate_qr.py.
export const MULTI_DAY_WINDOWS = {
  welcome: { anchorDate: '2026-07-17', validDays: null },
};

// Event types a resident may check into exactly once, ever — not once per day
// like the recurring lectures. Onboarding happens a single time, so a second
// welcome scan on a later date is a duplicate, not a new attendance.
//
// Enforced in two places, both required: checkin.js queries by (email, type)
// with no date, and a partial UNIQUE index closes the concurrent-scan race the
// table's UNIQUE (email, event_date, event_type) can't (it permits one row per
// *date*). Adding a type here means adding a matching index — see schema.sql.
export const ONCE_PER_RESIDENT = ['welcome'];

export function isOncePerResident(qrType) {
  return ONCE_PER_RESIDENT.includes(qrType);
}

export function dbValueToLabel(dbValue) {
  const entry = Object.values(EVENT_TYPES).find((e) => e.dbValue === dbValue);
  return entry ? entry.label : dbValue;
}
