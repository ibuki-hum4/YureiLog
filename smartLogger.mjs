import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('./dist/index.js');
export default mod && mod.default ? mod.default : mod;
export const SmartLogger = mod && mod.default ? mod.default : mod;
