import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SmartLogger = require('../smartLogger');
export default SmartLogger;
export { SmartLogger };
