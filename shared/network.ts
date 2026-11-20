export type RtspSettings = {supported:false} | {supported:true; enabled:boolean; port:number | null};

export type NetworkInterface = {
  addresses: string[]; active: boolean | null; enabled: boolean | null; dhcp: boolean | null;
};
export type CameraNetwork = {
  interfaces?: {ethernet: NetworkInterface | null; wifi: NetworkInterface | null};
  wifiSignal?: number | null;
  wifiStatus?: {associated:boolean|null; ssid:string|null; signal:string|null};
  wifiSwitchAvailable?: boolean;
  link: { address: string | null; netmask: string | null; gateway: string | null; dhcp: boolean | null } | null;
  wifi: { ssid: string | null; nearby: string[]; configurable: boolean } | null;
};

export function validWifiName(value: string) {
  const length = new TextEncoder().encode(value).length;
  return length > 0 && length <= 32 && !/\p{Cc}/u.test(value);
}

export function validWifiPassword(value: string, open: boolean) {
  if (open) return value === '';
  const length = new TextEncoder().encode(value).length;
  return (length >= 8 && length <= 63 && !/\p{Cc}/u.test(value)) || /^[0-9a-fA-F]{64}$/.test(value);
}
