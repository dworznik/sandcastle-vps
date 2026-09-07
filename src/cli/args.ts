export interface Args {
  /** Skip the Target picker and use this one. */
  readonly target?: string
  readonly help: boolean
}

export const HELP = `sandcastle-vps — install and run the sandcastle platform on a Target

Usage:
  npx @dworznik/sandcastle-vps [--target <name>]

Options:
  --target <name>   Use this Target profile instead of asking which one.
  -h, --help        Show this.

Everything else is a menu. Target profiles live in
~/.config/sandcastle-vps/targets/ and never hold a secret.`

export const parseArgs = (argv: readonly string[]): Args => {
  let target: string | undefined
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg === '--target') {
      target = argv[++i]
      if (target === undefined) throw new Error('--target needs a Target name.')
    } else if (arg?.startsWith('--target=')) {
      target = arg.slice('--target='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${HELP}`)
    }
  }
  return { target, help }
}
