/**
 * Strict CLI flag parsing shared by the release executables (R6
 * hardening): unknown flags and valueless flags are USAGE ERRORS, never
 * silently ignored. A renamed flag in a parser or in workflow YAML must
 * degrade to an explicit failure, not to a weaker default guard.
 *
 * Flags are "--kebab-case value" pairs; repeatable flags collect into
 * arrays. Returns { args } or { error }.
 */

const KEBAB_CAMEL = /-([a-z])/g;

export function parseCliFlags(argv, { flags, multi = [] }) {
  const known = new Set(flags.map((flag) => `--${flag}`));
  const multiFlags = new Set(multi.map((flag) => `--${flag}`));
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!known.has(current)) {
      return { error: `unknown argument "${current}" (known: ${[...known].join(" ")})` };
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: `missing value for ${current}` };
    }
    const key = current.slice(2).replace(KEBAB_CAMEL, (_, character) => character.toUpperCase());
    if (multiFlags.has(current)) {
      if (args[key] === undefined) {
        args[key] = [];
      }
      args[key].push(value);
    } else {
      args[key] = value;
    }
    index += 1;
  }
  return { args };
}
