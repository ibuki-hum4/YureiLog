import SmartLogger from '../smartLogger.mjs';
const lg = new SmartLogger({ label: 'ESM', colors: false });
lg.info('esm test ok');
lg.close();
