export const aiClasses = ['person', 'vehicle', 'pet', 'face', 'package'] as const;
export type AiClass = typeof aiClasses[number];
export const recordingKinds = ['continuous', 'motion', 'person', 'vehicle', 'pet', 'face', 'package', 'doorbell'] as const;
export type RecordingKind = typeof recordingKinds[number];
export type RecordingSchedule = { enabled: boolean; schedules: Partial<Record<RecordingKind, string>> };
export type TimeLapse = { enabled: boolean; configured: boolean; interval_seconds?: number; format?: string; stream?: string; overwrite?: boolean };
export const settingsGroups = ['spotlight', 'leds', 'motion', 'ai', 'image', 'recording_schedule', 'time_lapse'] as const;
export type SettingsGroup = typeof settingsGroups[number];

export const permissions = [
  'view', 'events', 'media.live', 'capture', 'recordings.view', 'recordings.export', 'audio.talk',
  'ptz.read', 'ptz.write', 'settings.spotlight.read', 'settings.spotlight.write',
  'settings.leds.read', 'settings.leds.write', 'settings.motion.read', 'settings.motion.write',
  'settings.ai.read', 'settings.ai.write', 'settings.image.read', 'settings.image.write',
  'settings.recording_schedule.read', 'settings.recording_schedule.write', 'settings.time_lapse.read', 'settings.time_lapse.write', 'settings.network.read', 'settings.network.write', 'alerts.read', 'alerts.write', 'device.rotate'
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
