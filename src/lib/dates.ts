const twoDigits = (part: number) => String(part).padStart(2, '0');

export const formatLocalTime = (date: Date) =>
  [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits).join(':');

export const formatLocalTimestamp = (value: string | number) => {
  const date = new Date(value);
  const day = [String(date.getFullYear()).padStart(4, '0'), twoDigits(date.getMonth() + 1), twoDigits(date.getDate())];
  return day.join('-') + ' ' + formatLocalTime(date);
};
