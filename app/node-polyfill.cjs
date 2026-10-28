// Polyfill URL.parse for Node.js < 22.1.0 / < 20.18.0
if (typeof URL.parse !== 'function') {
  URL.parse = function (url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}
