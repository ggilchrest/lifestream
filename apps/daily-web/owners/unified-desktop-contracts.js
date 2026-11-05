// Generated from published schemas; check with node scripts/generate-unified-desktop-contracts.mjs --check.
export const unifiedDesktopConsumerPins = Object.freeze({
  "conversation-history": Object.freeze({"schemaId":"https://lifestream.dev/contracts/conversation-history/1.0.0","schemaVersion":"1.0.0","digest":"3e999ba50f5181e02322a068bad9d6a66ffdb01263c50e1df284f6d3360cbdd2"}),
  "shell-preferences": Object.freeze({"schemaId":"https://lifestream.dev/contracts/shell-preferences/1.1.0","schemaVersion":"1.1.0","digest":"44fae5b9831a1818a9b9e7ff5786b31dcd445ab097d5e036e904314be862b3e3"}),
  "effective-subject": Object.freeze({"schemaId":"https://lifestream.dev/contracts/effective-subject/1.0.0","schemaVersion":"1.0.0","digest":"ed098cad970a310a807881ea7a833b96f1c980e8377ee3cfcbdffd68f2bd0cf9"}),
  "desktop-session": Object.freeze({"schemaId":"https://lifestream.dev/contracts/desktop-session/1.0.0","schemaVersion":"1.0.0","digest":"5abf1713a62b6402d08b4a4faba9c0e83bf199e13bf55f672421b6b20ccf6ac3"})
});

export function admitUnifiedDesktopProducer(boundary, pin) {
  const expected = unifiedDesktopConsumerPins[boundary];
  if (!expected || !pin || typeof pin !== 'object' || Array.isArray(pin)) return false;
  const fields = Object.getOwnPropertyDescriptors(pin);
  return Reflect.ownKeys(fields).length === 3 && ['schemaId','schemaVersion','digest'].every(key => fields[key] && 'value' in fields[key] && fields[key].value === expected[key]);
}
