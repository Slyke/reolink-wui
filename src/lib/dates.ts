export const formatLocalTimestamp = (value: string | number) => {
  const date = new Date(value);
  const twoDigits = (part: number) => String(part).padStart(2, '0');
  const day = [String(date.getFullYear()).padStart(4, '0'), twoDigits(date.getMonth() + 1), twoDigits(date.getDate())];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(twoDigits);
  return day.join('-') + ' ' + time.join(':');
};
