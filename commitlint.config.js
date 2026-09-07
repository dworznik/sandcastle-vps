export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Exactly the seven types CLAUDE.md documents, and deliberately no more: a
    // type nobody uses is how a spec stops describing reality.
    //
    // Dependabot, whenever it is enabled, defaults to a `build(deps):` prefix
    // this enum rejects — two abandoned Dependabot branches on this repo
    // already carry one. Set `commit-message.prefix: chore` in
    // .github/dependabot.yml rather than widening the enum to admit a type
    // that exists only to serve a bot.
    'type-enum': [2, 'always', ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'ci']],
  },
}
