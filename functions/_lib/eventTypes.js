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

// Event types whose QR is a single static image valid across a multi-day window,
// instead of rotating daily. The token is HMAC'd against anchorDate (not "today"),
// so the same printed/emailed QR keeps working every day in [anchorDate, anchorDate + validDays).
// Must mirror MULTI_DAY_WINDOWS in scripts/generate_qr.py.
export const MULTI_DAY_WINDOWS = {
  welcome: { anchorDate: '2026-07-17', validDays: 7 },
};

export function dbValueToLabel(dbValue) {
  const entry = Object.values(EVENT_TYPES).find((e) => e.dbValue === dbValue);
  return entry ? entry.label : dbValue;
}
