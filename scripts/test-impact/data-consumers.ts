/** Finds which source and test files read which entry (directory or file) of test/data. */

const PATTERNS = [
  /\b(?:dataSection|loadDataDir)\(\s*'([\w.-]+)'/g,
  /\bpath\.join\(\s*[\w.]*(?:dataDir|DataDir|DATA_DIR)\s*,\s*'([\w.-]+)'/g,
  /\btest\/data\/([\w.-]+)/g,
];
const DATA_LIST = /\bdata:\s*\[([^\]]*)\]/g;
const QUOTED = /'([\w.-]+)'/g;

export function scanDataConsumers(files: { path: string; text: string }[]): Map<string, Set<string>> {
  const consumers = new Map<string, Set<string>>();
  const add = (entry: string, file: string) => {
    const set = consumers.get(entry) ?? new Set<string>();
    consumers.set(entry, set.add(file));
  };

  for (const { path, text } of files) {
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) add(match[1] as string, path);
    }
    for (const list of text.matchAll(DATA_LIST)) {
      for (const entry of (list[1] as string).matchAll(QUOTED)) add(entry[1] as string, path);
    }
  }
  return consumers;
}
