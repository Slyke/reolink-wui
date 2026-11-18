import { z } from 'zod';
import { aiClasses, settingsGroups, type Permission, type SettingsGroup } from '../shared/access.js';
import { record, type Envelope } from './bridge-channels.js';
import { Failure } from './errors.js';
import type { Bridge } from './bridge.js';

const object = z.strictObject;
const int = (min: number, max: number) => z.number().int().min(min).max(max);
export const groupSchema = z.enum(settingsGroups);
export const ptzSchema = z.discriminatedUnion('op', [
  object({ op: z.literal('move'), direction: z.enum(['left', 'right', 'up', 'down', 'left_up', 'left_down', 'right_up', 'right_down', 'zoom_in', 'zoom_out']), duration_ms: int(50, 3000), speed: int(1, 64).optional() }),
  object({ op: z.literal('stop') }),
  object({ op: z.literal('status') }),
  object({ op: z.literal('list_presets') }),
  object({ op: z.literal('goto_preset'), preset_id: int(0, 255) }),
  object({ op: z.literal('set_zoom'), position: int(0, 2147483647) })
]);

export const settingSchema = z.discriminatedUnion('setting', [
  object({ setting: z.literal('spotlight'), enabled: z.boolean(), duration_seconds: int(1, 180).optional() }),
  object({ setting: z.literal('spotlight_brightness'), brightness: int(0, 100) }),
  object({ setting: z.literal('status_led'), enabled: z.boolean() }),
  object({ setting: z.literal('ir_led'), mode: z.enum(['auto', 'off']) }),
  object({ setting: z.literal('motion_detection'), enabled: z.boolean().optional(), sensitivity: int(1, 50).optional() })
    .refine(value => value.enabled !== undefined || value.sensitivity !== undefined),
  object({ setting: z.literal('image_orientation'), action: z.enum(['hflip', 'vflip', 'clockwise', 'counterclockwise']) }),
  object({ setting: z.literal('ai_detection'), class: z.enum(aiClasses), sensitivity: int(0, 100).optional(), delay_seconds: int(0, 8).optional() })
    .refine(value => value.sensitivity !== undefined || value.delay_seconds !== undefined)
]);

export const groupFor = (setting: z.infer<typeof settingSchema>['setting']): SettingsGroup => {
  if (setting === 'spotlight' || setting === 'spotlight_brightness') return 'spotlight';
  if (setting === 'status_led' || setting === 'ir_led') return 'leds';
  if (setting === 'motion_detection') return 'motion';
  if (setting === 'image_orientation') return 'image';
  return 'ai';
};

const displayText = (value: unknown) => (
  typeof value === 'string' && value.length <= 200 && !/[\x00-\x1F\x7F]|:\/\//.test(value) ? value : undefined
);
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const date = (value: unknown) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : undefined;
const range = (value: unknown) => {
  const r = record(value);
  const min = num(r.min);
  const max = num(r.max);
  return min !== undefined && max !== undefined && min <= max ? { min, max } : undefined;
};

export const information = ({ state }: { state: Map<string, Envelope> }) => {
  const info = state.get('info');
  const native = record(info?.baichuan);
  const onvif = record(info?.onvif);
  return {
    name: displayText(native.name ?? onvif.name),
    model: displayText(native.model ?? onvif.model),
    hardware: displayText(native.hardware ?? onvif.hardware_id),
    firmware: displayText(native.firmware ?? onvif.firmware)
  };
};

export const eventData = ({ raw }: { raw: Envelope }) => ({
  type: displayText(raw.type),
  vendorTopic: displayText(raw.vendor_topic),
  source: displayText(raw.source),
  ruleId: displayText(raw.rule_id),
  active: bool(raw.active),
  receivedAt: date(raw.received_at),
  cameraTime: date(raw.camera_time),
  objects: Array.isArray(raw.objects) ? raw.objects.slice(0, 50).map(entry => {
    const item = record(entry);
    const box = record(item.bounding_box);
    const trackId = item.tracking_id ?? item.track_id;
    return {
      class: displayText(item.class), confidence: num(item.confidence),
      trackId: typeof trackId === 'number' ? num(trackId) : displayText(trackId),
      box: {
        left: num(box.left), right: num(box.right), top: num(box.top), bottom: num(box.bottom),
        coordinateSpace: displayText(box.coordinate_space), referenceFrame: displayText(box.reference_frame),
        frameWidth: num(box.frame_width), frameHeight: num(box.frame_height)
      }
    };
  }) : undefined
});

export type CameraEvent = { id: string; observedAt: number; event: ReturnType<typeof eventData> };

export const rules = ({ raw }: { raw: Envelope }) => Object.entries(raw)
  .filter(([key, entries]) => ['onvif', 'baichuan'].includes(key) && Array.isArray(entries))
  .flatMap(([key, entries]) => (entries as unknown[]).slice(0, 128).map(value => {
    const item = record(value);
    return {
      id: displayText(item.id), type: displayText(item.type), name: displayText(item.name),
      source: key, enabled: bool(item.enabled), configurationId: displayText(item.configuration_id)
    };
  }));

const sanitizeGroup = ({ raw, group }: { raw: Envelope; group: SettingsGroup }) => {
  if (group === 'spotlight') return {
    enabled: bool(raw.enabled), brightness: num(raw.brightness),
    brightness_min: num(raw.brightness_min), brightness_max: num(raw.brightness_max)
  };
  if (group === 'leds') return { status_led: bool(raw.status_led), ir_mode: ['auto', 'off'].includes(String(raw.ir_mode)) ? raw.ir_mode : undefined };
  if (group === 'image') return { hflip: bool(raw.hflip), vflip: bool(raw.vflip), rotation: num(raw.rotation) };
  if (group === 'motion') return { enabled: bool(raw.enabled), sensitivity: num(raw.sensitivity) };
  return { sensitivity: num(raw.sensitivity), delay_seconds: num(raw.delay_seconds) };
};

export const settingValues = ({ raw, group }: { raw: Envelope; group: SettingsGroup }): Envelope => {
  const names = (group === 'ai' ? aiClasses.map(name => 'ai_' + name) : [group === 'motion' ? 'motion_detection' : group]);
  return Object.fromEntries(names.filter(key => Object.hasOwn(raw, key)).map(key => [key, sanitizeGroup({ raw: record(raw[key]), group })]));
};

export const ptzData = ({ raw }: { raw: Envelope }) => {
  const zoom = record(raw.zoom);
  return { pan: num(raw.pan), tilt: num(raw.tilt), zoom: { position: num(zoom.position), range: range(zoom.range) } };
};

export const statusPtz = ({ raw }: { raw: Envelope }) => {
  const position = raw.position ?? raw;
  const presets = Array.isArray(raw.presets) ? raw.presets.slice(0, 256).map(value => {
    const item = record(value);
    return { id: num(item.id), name: displayText(item.name) };
  }).filter(item => item.id !== undefined) : undefined;
  return {
    position: ptzData({ raw: record(position) }), presets,
    stopped: bool(raw.stopped), interrupted: bool(raw.interrupted),
    receivedAt: date(raw.received_at)
  };
};

export const capabilities = ({ bridge, remote, grant, proxy = false }: {
  bridge: Bridge; remote: string; grant: Set<Permission>; proxy?: boolean
}) => {
  const state = bridge.state(remote);
  const caps = state.get('capabilities');
  const raw = record(caps?.ptz);
  const ctrls = record(record(caps?.baichuan).controls);
  const led = record(ctrls.leds);
  const light = record(ctrls.spotlight);
  const motion = record(ctrls.motion_detection);
  const discovery = displayText(raw.discovery);
  const settings: Partial<Record<SettingsGroup, Envelope>> = {};
  const group = (key: SettingsGroup, fields: Envelope) => {
    if (grant.has('settings.' + key + '.read' as Permission) || grant.has('settings.' + key + '.write' as Permission)
      || (key === 'motion' && (grant.has('alerts.read') || grant.has('alerts.write')))) {
      settings[key] = {
        ...fields, read: grant.has('settings.' + key + '.read' as Permission),
        write: bridge.canCommand() && grant.has('settings.' + key + '.write' as Permission)
      };
    }
  };
  group('spotlight', {
    manual: bool(light.manual), brightness: bool(light.brightness),
    range: range({ min: light.brightness_min, max: light.brightness_max })
  });
  const orientation = record(ctrls.image);
  if (Object.keys(orientation).length) group('image', { hflip: bool(orientation.hflip), vflip: bool(orientation.vflip), rotation: bool(orientation.rotation) });
  group('leds', { statusLed: bool(led.status_led), irLed: bool(led.ir_led) });
  group('motion', { enabled: bool(motion.enabled), sensitivity: bool(motion.sensitivity) });
  group('ai', { classes: Object.fromEntries(aiClasses.filter(name => Object.hasOwn(ctrls, 'ai_' + name)).map(name => {
    const ai = record(ctrls['ai_' + name]);
    return [name, { sensitivity: bool(ai.sensitivity), delaySeconds: bool(ai.delay_seconds) }];
  })) });
  const imageGrant = grant.has('settings.image.read') || grant.has('settings.image.write');
  const imageOrientation = imageGrant ? (Object.keys(orientation).length ? 'available'
    : bridge.hasImageSettings() ? 'unsupported' : 'bridge-update-required') : undefined;
  const media = grant.has('media.live') ? (proxy ? ['main'] : bridge.streams(remote)) : [];
  const bridgePreview = grant.has('media.live') && bridge.hasPreview(remote);
  return {
    discovered: !!caps,
    imageOrientation,
    events: grant.has('events'),
    recordings: grant.has('recordings.view') && bridge.hasStorage(remote),
    recordingMetadata: grant.has('recordings.view') && bridge.hasRecordingMetadata(remote),
    recordingPreview: grant.has('recordings.view') && bridge.hasRecordingPreview(remote),
    recordingPlayback: grant.has('recordings.view') && bridge.hasRecordings(remote),
    capture: grant.has('capture') && bridge.canCapture(remote),
    mediaAllowed: grant.has('media.live'),
    preview: bridgePreview,
    bridgePreview,
    viaProxy: proxy && grant.has('media.live'),
    media,
    alerts: { read: grant.has('alerts.read'), write: bridge.canCommand() && grant.has('alerts.write') && (motion.enabled === true || motion.sensitivity === true) },
    rotate: grant.has('device.rotate') && bridge.has('enrollment'),
    freshSettings: bridge.has('v1'),
    ptz: grant.has('ptz.read') || grant.has('ptz.write') ? {
      discovery, supported: bool(raw.supported), read: grant.has('ptz.read'), write: bridge.canCommand() && grant.has('ptz.write'),
      pan: bool(raw.pan), tilt: bool(raw.tilt), diagonal: bool(raw.diagonal), directionalZoom: bool(raw.directional_zoom),
      presets: bool(raw.presets), speed: range(raw.speed_range), zoom: range(raw.zoom_range), duration: range(raw.duration_ms)
    } : undefined,
    settings
  };
};

export const available = ({ bridge, remote }: { bridge: Bridge; remote: string }) => {
  const source = bridge.state(remote).get('availability');
  return { stale: !bridge.feedReady, online: bridge.feedReady ? bool(source?.online) : undefined, updatedAt: date(source?.updated_at) };
};

const allowedRange = ({ value, bounds }: { value: number; bounds?: { min: number; max: number } }) => (
  bounds && value >= bounds.min && value <= bounds.max
);

export const validatePtz = ({ action, caps }: {
  action: z.infer<typeof ptzSchema>; caps: ReturnType<typeof capabilities>['ptz']
}) => {
  if (action.op === 'stop') {
    // Allow Stop while state is stale; the bridge still enforces its PTZ capability.
    if (caps?.supported !== false) return;
  } else if (caps?.supported) {
    if (action.op === 'status' || ((action.op === 'list_presets' || action.op === 'goto_preset') && caps.presets)) return;
    if (action.op === 'set_zoom' && allowedRange({ value: action.position, bounds: caps.zoom })) return;
    if (action.op === 'move') {
      const direction = action.direction;
      const supported = direction.startsWith('zoom_') ? caps.directionalZoom
        : (direction.includes('_') ? caps.diagonal : (['left', 'right'].includes(direction) ? caps.pan : caps.tilt));
      if (supported && allowedRange({ value: action.duration_ms, bounds: caps.duration })
        && (action.speed === undefined || allowedRange({ value: action.speed, bounds: caps.speed }))) return;
    }
  }
  throw new Failure('UNSUPPORTED', 422);
};

export const validateSetting = ({ value, settings }: {
  value: z.infer<typeof settingSchema>; settings: ReturnType<typeof capabilities>['settings']
}) => {
  const group = settings[groupFor(value.setting)];
  if (group) {
    switch (value.setting) {
      case 'spotlight': if (group.manual === true) return; break;
      case 'spotlight_brightness': if (group.brightness && allowedRange({ value: value.brightness, bounds: group.range as ReturnType<typeof range> })) return; break;
      case 'image_orientation':
        if ((value.action === 'hflip' && group.hflip) || (value.action === 'vflip' && group.vflip)
          || (['clockwise', 'counterclockwise'].includes(value.action) && group.rotation)) return;
        break;
      case 'status_led': if (group.statusLed === true) return; break;
      case 'ir_led': if (group.irLed === true) return; break;
      case 'motion_detection': if ((value.enabled === undefined || group.enabled) && (value.sensitivity === undefined || group.sensitivity)) return; break;
      case 'ai_detection': {
        const ai = record(record(group.classes)[value.class]);
        if ((value.sensitivity === undefined || ai.sensitivity) && (value.delay_seconds === undefined || ai.delaySeconds)) return;
      }
    }
  }
  throw new Failure('UNSUPPORTED', 422);
};

export const readback = ({ raw, group, className }: { raw: Envelope; group: SettingsGroup; className?: string }) => {
  const stateKey = group === 'motion' ? 'motion_detection' : (group === 'ai' ? 'ai_' + className : group);
  if (raw[stateKey]) return settingValues({ raw, group });
  return settingValues({ raw: { [stateKey]: raw }, group });
};

export const visibleState = ({ bridge, remote, grant }: { bridge: Bridge; remote: string; grant: Set<Permission> }) => {
  const cached = bridge.state(remote);
  const coordinates = record(cached.get('capabilities')?.coordinate_stream);
  const settings = cached.get('state/settings') ?? {};
  return {
    availability: available({ bridge, remote }),
    coordinateStream: { enabled: bool(coordinates.enabled) ?? (coordinates.transport ? true : undefined), connected: bool(coordinates.connected), overlayObserved: bool(coordinates.overlay_observed) },
    settings: Object.fromEntries(settingsGroups.filter(group => grant.has('settings.' + group + '.read' as Permission))
      .map(group => [group, settingValues({ raw: settings, group })])),
    position: grant.has('ptz.read') && cached.has('state/ptz') ? statusPtz({ raw: cached.get('state/ptz')! }) : undefined,
    detections: grant.has('events') ? [...cached.entries()].filter(([topic]) => topic.startsWith('state/') && !['state/settings', 'state/ptz', 'state/preview'].includes(topic))
      .map(([topic, raw]) => ({ type: topic.slice(6), active: bool(raw.active), last: eventData({ raw: record(raw.last) }) })) : undefined
  };
};
