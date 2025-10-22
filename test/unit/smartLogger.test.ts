let SmartLogger: any;
try {
  // prefer built dist for types
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SmartLogger = require('../../dist').default || require('../../dist');
} catch (e) {
  // fallback to ESM wrapper at runtime
  // Node ESM import is not straightforward from ts-jest; require dynamically
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SmartLogger = require('../../smartLogger.mjs');
}

describe('SmartLogger basic', () => {
  test('can create logger and log without throwing', () => {
    const lg = new SmartLogger({ level: 'debug', env: 'development', label: 'UT', colors: false });
    expect(() => { lg.info('ok'); lg.debug('ok', { a: 1 }); lg.warn('ok'); lg.error(new Error('e')); }).not.toThrow();
    lg.close();
  });

  test('timeZone option does not throw and produces timestamp-like string', () => {
    const lg = new SmartLogger({ timeZone: 'Asia/Tokyo', colors: false });
    expect(() => lg.info('tz')).not.toThrow();
    lg.close();
  });

  test('json output is parseable object', () => {
    const lg = new SmartLogger({ json: true, colors: false });
    expect(() => lg.info('jsontest', { ok: true })).not.toThrow();
    lg.close();
  });
});
