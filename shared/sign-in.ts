export type GroupPolicy = { requiredGroups: string[]; requiredGroupsMode: 'any' | 'all' };
export type AccountType = 'local' | 'oauth' | 'headers';
export type ExternalType = Exclude<AccountType, 'local'>;
