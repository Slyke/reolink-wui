import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDb, audit } from './db.js';
import { readConfig } from './config.js';
import { isLocal, passwordHash } from './auth.js';
import { input, shortLabel, username } from './runtime.js';
import { classifyLegacyIdentities, identityProvider, linkIdentity, linkedAccount, type ExternalIdentity } from './identities.js';

const bootstrap = async () => {
  process.umask(0o077);
  const [command, method, identifier, label, secretPath, extra] = process.argv.slice(2);
  if (command !== 'bootstrap' || !identifier || !label || extra || !['local','external','oauth','headers'].includes(method)) throw new Error();
  const config = readConfig();
  const name = input({ schema: shortLabel, value: label });
  let user: string | null = null;
  let password: string | null = null;
  let identity: ExternalIdentity | undefined;
  if (method === 'local') {
    if (!isLocal({ config }) || !secretPath) throw new Error();
    user = input({ schema: username, value: identifier });
    password = await passwordHash({ password: readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '') });
  } else {
    if (secretPath || !/^[^\x00-\x20\x7f,]{1,180}$/.test(identifier)) throw new Error();
    identity = { ...identityProvider(config, method === 'oauth' || method === 'headers' ? method : undefined), subject: identifier };
  }
  const sql = await openDb({ config: config.database });
  try {
    await sql.transaction(async query => {
      if ((await query('SELECT id FROM accounts WHERE admin=1 LIMIT 1')).length) throw new Error();
      await classifyLegacyIdentities(query, config);
      const existing = identity ? await linkedAccount(query, identity) : undefined;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        await query('UPDATE accounts SET admin=1,enabled=1,label=$1 WHERE id=$2', name, id);
        await query('DELETE FROM sessions WHERE account_id=$1', id);
      } else {
        await query('INSERT INTO accounts(id,label,username,password_hash,admin,enabled) VALUES ($1,$2,$3,$4,1,1)', id, name, user, password);
        if (identity) await linkIdentity(query, identity, id);
      }
      await audit({ query, actor: id, resource: 'accounts', action: 'bootstrap', outcome: 'confirmed', correlation: randomUUID() });
    });
    console.log('Installation administrator created.');
  } finally {
    await sql.close();
  }
};

void bootstrap().catch(() => {
  console.error('Bootstrap failed. Use a database with no administrator, a configured sign-in method, and a private password file for local sign-in.');
  process.exitCode = 1;
});
