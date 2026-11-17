import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { api } from './api.js';
import { readConfig, type Config } from './config.js';
import { boot, logs } from './errors.js';

const tlsOptions = ({ config }: { config: Config }) => {
  const tls = config.listen.tls;
  if (!tls) return undefined;
  if (tls.cert && tls.key) {
    createSecureContext({ cert: tls.cert, key: tls.key });
    return { cert: tls.cert, key: tls.key };
  }
  const folder = mkdtempSync(join(tmpdir(), 'wui-tls-'));
  const cert = join(folder, 'certificate.pem');
  const key = join(folder, 'private-key.pem');
  try {
    const names = [config.publicOrigin.hostname.replace(/^\[|\]$/g, ''), ...tls.serverNames]
      .map(name => (isIP(name) ? 'IP:' : 'DNS:') + name).join(',');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', key, '-out', cert, '-days', '30',
      '-subj', '/CN=Reolink WUI', '-addext', 'subjectAltName=' + names
    ], { stdio: 'ignore', timeout: 15_000 });
    return { cert: readFileSync(cert), key: readFileSync(key) };
  } finally {
    for (const file of [cert, key]) { try { unlinkSync(file); } catch { /* File was never generated. */ } }
    rmdirSync(folder);
  }
};

const start = async () => {
  process.umask(0o077);
  const config = readConfig();
  const tls = tlsOptions({ config });
  const { app } = await api({ config, tls });
  if (config.database.driver === 'sqlite' && config.database.path !== ':memory:') await chmod(config.database.path, 0o600);
  await app.listen({ host: config.listen.host, port: config.listen.port });
  boot({ caller: 'api::start' });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      const force = setTimeout(() => process.exit(1), 4000).unref();
      app.server.closeAllConnections?.();
      void app.close().then(() => clearTimeout(force)).catch(() => process.exit(1));
    });
  }
};

void start().catch(() => {
  logs.generateError({ caller: 'api::start', reason: 'API startup failed. Check private configuration and dependency connectivity.', errorKey: 'CONFIG_INVALID', includeStackTrace: false });
  process.exit(1);
});
