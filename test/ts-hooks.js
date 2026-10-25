const { registerHooks } = require('node:module');

// The extension imports its siblings as .js, as tsc emits them; Node runs the .ts source.
const canRunTs = typeof registerHooks === 'function' && !!process.features.typescript;
if (canRunTs) {
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        if (!specifier.endsWith('.js') || !context.parentURL?.includes('/extensions/')) throw e;
        return next(specifier.replace(/\.js$/, '.ts'), context);
      }
    },
  });
}

const SKIP_TS = !canRunTs && 'needs Node with registerHooks and type stripping';

module.exports = { SKIP_TS };
