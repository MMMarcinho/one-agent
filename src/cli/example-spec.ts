/** Template written by `one-agent init`. Kept in sync with specSchema. */
export const EXAMPLE_SPEC = `# one-agent orchestration spec
# Defines which agents exist, what each is for, who may delegate to whom,
# and how routing and delegation recursion are bounded.
version: 1

# Agent used when you don't pick one and no routing rule matches.
defaultAgent: claude-code

agents:
  claude-code:
    type: claude-code          # adapter: drives the \`claude\` CLI
    # command: claude           # override the binary if needed
    permissionMode: acceptEdits # plan | ask | acceptEdits | auto | bypass
    role: General-purpose coding, repo-wide reasoning and refactors.
    canDelegateTo: [codex]      # this agent may spawn codex

  codex:
    type: codex                 # adapter: drives the \`codex\` CLI
    permissionMode: acceptEdits
    role: Fast focused edits and an independent second opinion.
    canDelegateTo: [claude-code]

  # Any ACP-compatible agent plugs in generically:
  # gemini:
  #   type: acp
  #   command: gemini
  #   args: ["--experimental-acp"]
  #   role: Large-context analysis.
  #   canDelegateTo: []

routing:
  auto: true                    # let one-agent pick the agent (use \`auto\` in the TUI)
  rules:                        # \`when\` matches the prompt + cwd; substring or /regex/
    - when: /\\b(test|spec)\\b/i
      use: codex
    # - when: "refactor"
    #   use: claude-code

delegation:
  enabled: true                 # allow agents to spawn other agents
  maxDepth: 2                   # cap agent -> agent recursion
  audit: true                   # record every delegated run
`;
