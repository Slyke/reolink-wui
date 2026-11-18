import { t } from './api.js';
import type { Recording } from '../../shared/recordings.js';

export const recordingSize = ({ value }: { value: number | null }) => {
  if (value === null) return t('empty-value');
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];
  const index = Math.min(3, Math.max(0, Math.floor(Math.log10(Math.max(1, value)) / 3)));
  return new Intl.NumberFormat(undefined, { style: 'unit', unit: units[index], unitDisplay: 'short', maximumFractionDigits: 1 }).format(value / (1000 ** index));
};
export const recordingDuration = ({ recording }: { recording: Recording }) => {
  const seconds = Math.max(0, Math.round((Date.parse(recording.end + 'Z') - Date.parse(recording.start + 'Z')) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2,'0')).join(':');
};
export const recordingKinds = ({ value }: { value: string | null }) => {
  const names: Record<string,string> = { md: 'motion', pir: 'motion', people: 'person', dog_cat: 'pet', vehicle: 'vehicle', face: 'face', package: 'package', visitor: 'doorbell' };
  return value ? value.split(',').map(part => part.trim()).filter(Boolean).map(part => names[part] ? t(names[part]) : part).join(', ') : t('empty-value');
};
