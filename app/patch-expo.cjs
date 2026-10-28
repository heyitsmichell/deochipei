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

// Keep executable headers first, including when repairing the older patch.
function patchCli(content) {
  const oldPrefix = polyfill + '\n';
  if (content.startsWith(oldPrefix)) content = content.slice(oldPrefix.length);
  if (content.includes('URL.parse')) return content;
  const newline = content.indexOf('\n');
  if (content.startsWith('#!')) {
    const header = newline < 0 ? content + '\n' : content.slice(0, newline + 1);
    return header + polyfill + (newline < 0 ? '' : content.slice(newline + 1));
  }
  return polyfill + content;
}

module.exports = { patchCli };
if (require.main === module) {
  for (const target of targets) {
    if (fs.existsSync(target)) {
      const content = fs.readFileSync(target, 'utf8');
      const patched = patchCli(content);
      if (patched !== content) fs.writeFileSync(target, patched, 'utf8');
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
}
