const jest = require('jest');
const argv = process.argv.slice(2);

// run jest programmatically
(async ()=>{
  const args = ['--runInBand'].concat(argv);
  const res = await jest.runCLI({ config: JSON.stringify({ preset: 'ts-jest', testEnvironment: 'node', testMatch: ['**/test/unit/**/*.test.ts'] }) }, [process.cwd()]);
  if (!res || !res.results) process.exit(1);
  const ok = res.results.success;
  process.exit(ok ? 0 : 1);
})();
