export const aiClasses = ['person', 'vehicle', 'pet', 'face', 'package'] as const;
export type AiClass = typeof aiClasses[number];
export const settingsGroups = ['spotlight', 'leds', 'motion', 'ai', 'image'] as const;
export type SettingsGroup = typeof settingsGroups[number];

export const permissions = [
  'view', 'events', 'media.live', 'capture', 'recordings.view', 'recordings.export', 'audio.talk',
  'ptz.read', 'ptz.write', 'settings.spotlight.read', 'settings.spotlight.write',
  'settings.leds.read', 'settings.leds.write', 'settings.motion.read', 'settings.motion.write',
  'settings.ai.read', 'settings.ai.write', 'settings.image.read', 'settings.image.write', 'alerts.read', 'alerts.write', 'device.rotate'
] as const;
export type Permission = typeof permissions[number];

const viewer: Permission[] = ['view', 'events', 'media.live'];
const operator: Permission[] = [
  ...viewer, 'capture', 'ptz.read', 'ptz.write', 'settings.spotlight.read', 'settings.spotlight.write',
  'settings.leds.read', 'settings.leds.write', 'settings.motion.read', 'alerts.read'
];
export const presets = {
  viewer,
  operator,
  'camera-admin': permissions.filter(item => !['audio.talk', 'recordings.export'].includes(item))
};
