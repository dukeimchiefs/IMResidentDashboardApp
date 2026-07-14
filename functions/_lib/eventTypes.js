// Single source of truth mapping QR-payload prefixes -> DB values -> display labels.
// NOTE: scripts/generate_qr.py mirrors QR_PREFIXES as a plain Python list since it
// can't import this module directly. Adding a new event type means updating both.
export const EVENT_TYPES = {
  noon: { dbValue: 'noon_conference', label: 'Noon Conference' },
  learning: { dbValue: 'learning_session', label: 'Learning Session' },
  grandrounds: { dbValue: 'grand_rounds', label: 'Medicine Grand Rounds' },
};

export const QR_PREFIXES = Object.keys(EVENT_TYPES); // ['noon', 'learning', 'grandrounds']

export function dbValueToLabel(dbValue) {
  const entry = Object.values(EVENT_TYPES).find((e) => e.dbValue === dbValue);
  return entry ? entry.label : dbValue;
}
