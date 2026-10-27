const fs = require('fs');
const path = require('path');

const polyfill = `if (typeof URL.parse !== 'function') {
  URL.parse = function (url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}
`;

const targets = [
  path.join(__dirname, 'node_modules', 'expo', 'bin', 'cli'),
  path.join(__dirname, 'node_modules', 'expo', 'node_modules', '@expo', 'cli', 'bin', 'cli.js'),
  path.join(__dirname, 'node_modules', '@expo', 'cli', 'bin', 'cli.js'),
];

for (const target of targets) {
  if (fs.existsSync(target)) {
    const content = fs.readFileSync(target, 'utf8');
    if (!content.includes('URL.parse')) {
      fs.writeFileSync(target, polyfill + '\n' + content, 'utf8');
      console.log(`[patch-expo] Patched ${target}`);
    }
  }
}

// Patch Windows open.js for cmd.exe URL & escaping bug
const openTargets = [
  path.join(__dirname, 'node_modules', 'expo', 'node_modules', '@expo', 'cli', 'build', 'src', 'utils', 'open.js'),
  path.join(__dirname, 'node_modules', '@expo', 'cli', 'build', 'src', 'utils', 'open.js'),
];

for (const openTarget of openTargets) {
  if (fs.existsSync(openTarget)) {
    let content = fs.readFileSync(openTarget, 'utf8');
    if (content.includes('startArgs.push(target, ...browserArgs);') && !content.includes('escapedTarget')) {
      content = content.replace(
        'startArgs.push(target, ...browserArgs);',
        `const escapedTarget = typeof target === 'string' ? target.replace(/&/g, '^&') : target;\n    startArgs.push(escapedTarget, ...browserArgs);`
      );
      fs.writeFileSync(openTarget, content, 'utf8');
      console.log(`[patch-expo] Patched ${openTarget}`);
    }
  }
}
