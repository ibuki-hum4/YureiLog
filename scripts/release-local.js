const { execSync } = require('child_process');

try {
  console.log('Running preflight...');
  execSync('npm run preflight', { stdio: 'inherit' });

  if (process.env.NPM_TOKEN) {
    console.log('Using NPM_TOKEN env; creating temporary .npmrc');
    const homedir = process.env.HOME || process.env.USERPROFILE;
    const npmrc = require('path').join(homedir, '.npmrc');
    require('fs').appendFileSync(npmrc, `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`);
  } else {
    console.log('No NPM_TOKEN provided; will prompt for interactive login if needed');
  }

  execSync('npm publish --access public', { stdio: 'inherit' });
  console.log('\nPublish succeeded.');
} catch (e) {
  console.error('\nPublish failed:', e.message);
  process.exit(1);
} finally {
  if (process.env.NPM_TOKEN) {
    const homedir = process.env.HOME || process.env.USERPROFILE;
    const npmrc = require('path').join(homedir, '.npmrc');
    try {
      const content = require('fs').readFileSync(npmrc, 'utf8');
      const filtered = content.split(/\r?\n/).filter(l => !l.includes('_authToken')).join('\n');
      require('fs').writeFileSync(npmrc, filtered, 'utf8');
      console.log('Cleaned temporary token from .npmrc');
    } catch (e) {}
  }
}
