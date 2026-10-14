export interface EnvVariable { key: string; value: string }

// Parse dotenv data as text. Values are never evaluated or interpolated.
export function parseEnvText(text: string): EnvVariable[] {
  const values = new Map<string, string>();
  const assignments = /(?:^|\n)[^\S\n]*(?:export[^\S\n]+)?([A-Za-z_][A-Za-z0-9_]*)[^\S\n]*=[^\S\n]*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\r\n]*))/g;
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  for (const match of normalized.matchAll(assignments)) {
    const value = match[2] !== undefined
      ? match[2].replace(/\\([\\"nr])/g, (_, escaped: string) => escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped)
      : match[3] !== undefined ? match[3] : match[4].split("#", 1)[0].trim();
    values.set(match[1], value);
  }
  return [...values].map(([key, value]) => ({ key, value }));
}

export function mergeEnvVariables(current: EnvVariable[], ...files: EnvVariable[][]): EnvVariable[] {
  const result = current.map(variable => ({ ...variable }));
  const positions = new Map(result.map((variable, index) => [variable.key, index]));
  for (const file of files) for (const variable of file) {
    const position = positions.get(variable.key);
    if (position === undefined) { positions.set(variable.key, result.length); result.push(variable); }
    else result[position] = variable;
  }
  return result;
}
