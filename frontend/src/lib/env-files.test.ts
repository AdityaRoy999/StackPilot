import { describe, expect, it } from "vitest";
import { mergeEnvVariables, parseEnvText } from "./env-files";

describe("env file import", () => {
  it("reads BOM, export, comments, equals signs, quoted hashes, and multiline values without evaluating them", () => {
    expect(parseEnvText('\uFEFF# comment\r\nexport HOST = example.test # note\r\nURL="https://example.test/?a=1#part"\nKEY="first\\nsecond"\nPEM=\'line one\nline two\'\nLITERAL=${HOST}\nBAD-KEY=value\nEMPTY=\n')).toEqual([
      { key: "HOST", value: "example.test" }, { key: "URL", value: "https://example.test/?a=1#part" },
      { key: "KEY", value: "first\nsecond" }, { key: "PEM", value: "line one\nline two" },
      { key: "LITERAL", value: "${HOST}" }, { key: "EMPTY", value: "" },
    ]);
  });
  it("merges files in order, preserving manual variables and replacing duplicate keys", () => {
    const current = [{ key: "MANUAL", value: "keep" }, { key: "HOST", value: "old" }];
    expect(mergeEnvVariables(current, parseEnvText('HOST=first\nPORT=80\nPORT=81'), parseEnvText('HOST=last'))).toEqual([
      { key: "MANUAL", value: "keep" }, { key: "HOST", value: "last" }, { key: "PORT", value: "81" },
    ]);
    expect(current[1].value).toBe("old");
  });
  it("does not consume the next assignment after an empty value or decode an escaped backslash twice", () => {
    expect(parseEnvText('EMPTY=\nNEXT=ok\nLITERAL="\\\\n"')).toEqual([
      { key: "EMPTY", value: "" }, { key: "NEXT", value: "ok" }, { key: "LITERAL", value: "\\n" },
    ]);
  });
});
