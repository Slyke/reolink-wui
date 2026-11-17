const uidPattern = /^[A-Za-z0-9]{8,40}$/;
const serialPattern = /^[A-Za-z0-9-]{4,64}$/;
const header = 'REOLINK-WUI/1';
export const validIdentifiers = ({ uid, serial }: { uid: string; serial: string }) => (
  Boolean(uid || serial) && (!uid || uidPattern.test(uid)) && (!serial || serialPattern.test(serial))
);

export const enrollmentText = ({ uid, serial }: { uid: string; serial: string }) => {
  if (!validIdentifiers({ uid, serial })) throw new Error('BAD_INPUT');
  return header + '\nUID:' + uid + '\nSERIAL:' + serial;
};

export const parseDeviceLabel = ({ value }: { value: string }) => {
  const data = value.trim();
  if (uidPattern.test(data)) return { uid: data, serial: '' };
  const lines = data.split('\n');
  if (lines.length !== 3 || lines[0] !== header || !lines[1].startsWith('UID:') || !lines[2].startsWith('SERIAL:')) return;
  const found = { uid: lines[1].slice(4), serial: lines[2].slice(7) };
  return validIdentifiers(found) ? found : undefined;
};

export const wifiBytes = ({ ssid, password, code }: { ssid: string; password: string; code: string }) => {
  if (!ssid || ssid.length > 32 || password.length > 64 || !/^[A-Za-z0-9]{4}$/.test(code)
    || [...ssid + password].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 255)) throw new Error('wifi-invalid');
  const xml = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return Uint8ClampedArray.from('<QR><S>' + xml(ssid) + '</S><P>' + xml(password) + '</P><C>' + code + '</C></QR>', value => value.charCodeAt(0));
};
