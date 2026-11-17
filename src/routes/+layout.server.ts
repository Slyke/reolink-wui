import { building } from '$app/environment';
import { browserPath, readConfig } from '../../server/config.js';
import type { LayoutServerLoad } from './$types';

const config = building ? undefined : readConfig();

export const load: LayoutServerLoad = () => ({
  apiBasePath: config ? browserPath({ config }) : '/api'
});
