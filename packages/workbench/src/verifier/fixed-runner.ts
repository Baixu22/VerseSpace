/** Bootstrap generated into the private copy. Restricted modules are for trusted
 * offline checks, not a security boundary for adversarial JavaScript. */
export const FIXED_RUNNER = `
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const plan = JSON.parse(readFileSync(new URL('./.workbench-fixed-plan.json', import.meta.url), 'utf8'));
const root = process.cwd();
const files = new Set(plan.files.map(path => pathToFileURL(resolve(root, path)).href));
const builtin = new Set(['fs','fs/promises','path','assert','assert/strict','crypto','buffer','util','url','timers','timers/promises','string_decoder']);
const gap = (message) => Object.assign(new Error(message), {code:'ERR_WORKBENCH_FIXED_SCOPE'});
globalThis.fetch = undefined;
globalThis.WebSocket = undefined;
registerHooks({
  resolve(specifier, context, next) {
    const name = specifier.replace(/^node:/, '');
    if (builtin.has(name)) return next(specifier, context);
    if (!specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('/') && !/^[A-Za-z]:/.test(specifier))
      throw gap('undeclared module: ' + specifier);
    const resolved = next(specifier, context);
    if (!files.has(resolved.url)) throw gap('module outside declared files');
    return resolved;
  }
});
try {
  await import(pathToFileURL(resolve(root, plan.script)).href);
} catch (error) {
  if (['ERR_ACCESS_DENIED','ERR_WORKBENCH_FIXED_SCOPE','MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ENOENT'].includes(error.code)) {
    console.error('WORKBENCH_FIXED_INPUT_GAP:' + error.code);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
`;
