// Synthetic dump shaped like dsh 0.2.1-rc.2; contains no user configuration.
export const realisticDump = [
  "---",
  "# == @deepseek-ai/unrelated-before ==",
  "- id: unrelated-before", "  name: '@deepseek-ai/example'", "  config:",
  "    tagged: !env SYNTHETIC_SETTING", "    values: [first, second]",
  "    prompt: |", "      - id: agent-default-model", "      synthetic prompt",
  "    quoted: 'a quoted value'", "    count: 0x10",
  "  inject:", "    - first-service", "    - second-service",
  "# == @deepseek-ai/agent-default-model ==",
  "- id: agent-default-model", "  name: '@deepseek-ai/agent-default-model'", "  config:",
  "    provider: custom-provider", "    model: original-model",
  "- name: unrelated-between", "  id: unrelated-between", "  config:", "    tagged: !expr synthetic",
  "    values: [1, 2]", '    quoted: "another value"', "    count: 1e3",
  "- id: llm-deepseek", "  name: '@deepseek-ai/llm-deepseek'",
  "- id: unrelated-after", "  config:", "    tagged: !env ANOTHER_SYNTHETIC_SETTING",
  "...", "",
].join("\n");
