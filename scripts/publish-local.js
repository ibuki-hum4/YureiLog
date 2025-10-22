const { execSync } = require('child_process');

try {
  if (process.env.NPM_TOKEN) {
    const homedir = process.env.HOME || process.env.USERPROFILE;
    const npmrc = require('path').join(homedir, '.npmrc');
    const line = `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`;
    require('fs').appendFileSync(npmrc, line, { encoding: 'utf8' });
    console.log('Appended NPM token to', npmrc);
  } else {
    console.log('NPM_TOKEN not present — falling back to interactive npm login');
    execSync('npm login', { stdio: 'inherit' });
  }

  execSync('npm publish --access public', { stdio: 'inherit' });
} catch (e) {
  console.error('publish failed:', e.message);
  process.exit(1);
} finally {
  if (process.env.NPM_TOKEN) {
    const homedir = process.env.HOME || process.env.USERPROFILE;
    const npmrc = require('path').join(homedir, '.npmrc');
    try {
      const content = require('fs').readFileSync(npmrc, 'utf8');
      const filtered = content.split(/\r?\n/).filter(l => !l.includes('_authToken')).join('\n');
      require('fs').writeFileSync(npmrc, filtered, 'utf8');
      console.log('Removed token from', npmrc);
    } catch (e) {}
  }
}
