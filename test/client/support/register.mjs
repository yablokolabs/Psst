/** Registers the app-module loader hooks before the test files are imported. */

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
