import {
  CAPTURE_ORDER,
  CREDENTIAL_LABEL,
  captureCredentials,
  missing,
  type CaptureResult,
  type CredentialName,
  type CredentialSession,
} from './credentials.js'
import { readEnvScript } from './install.js'
import type { VerifyOptions } from './verify.js'

/**
 * Replacing credentials the Target already holds.
 *
 * Rotation is capture with two switches flipped — replace instead of fill in,
 * and a chosen list instead of whatever is missing — which is why it is the
 * same flow rather than a second one. Keeping them together is what stops the
 * two drifting into disagreeing about what a captured credential looks like.
 *
 * It is one action rather than a walk over every Project because there is one
 * place credentials live (ADR 0006). The retired `sync-env` existed only
 * because there were N copies to keep aligned.
 */

/** The signing key is rotatable alongside the four environment credentials,
 *  but it is not one of them: it lives in a file, and replacing it is
 *  regenerating it on the Target rather than asking for a new value. */
export type Rotatable = CredentialName | 'signingKey'

export const isCredential = (choice: Rotatable): choice is CredentialName => choice !== 'signingKey'

/** What the operator is choosing between, and what each one currently is. */
export const rotateChoices = (
  envContent: string,
): { readonly label: string; readonly value: Rotatable }[] => {
  const absent = new Set(missing(envContent))
  return [
    ...CAPTURE_ORDER.map((name) => ({
      label: `${CREDENTIAL_LABEL[name]}${absent.has(name) ? ' — not captured yet' : ''}`,
      value: name as Rotatable,
    })),
    {
      label: 'Signing key — regenerate it on the Target, and register the new one',
      value: 'signingKey' as Rotatable,
    },
  ]
}

export interface RotateOptions {
  readonly verifyOptions?: Partial<VerifyOptions>
}

/**
 * The menu's "Rotate credentials". Returns what the Target looks like
 * afterwards, or `undefined` when nothing was chosen and nothing was touched.
 */
export const rotateCredentials = async (
  session: CredentialSession,
  log: (line: string) => void = console.log,
  { verifyOptions = {} }: RotateOptions = {},
): Promise<CaptureResult | undefined> => {
  const { profile, connector, prompter } = session

  const current = await connector.exec(readEnvScript(profile.installDir))
  const existing = current.stdout

  log('\nRotate credentials')
  log('Replaces what the Target already holds. One action, not one per Project:')
  log('the Harness holds the only copy (ADR 0006).')

  const picked = await prompter.multi('Which should be replaced?', rotateChoices(existing))
  if (picked.length === 0) {
    log('\nNothing chosen. Nothing was changed.')
    return undefined
  }

  const which = picked.filter(isCredential)
  const replaceSigningKey = picked.length !== which.length

  // Asked once, and named, because the old values do not come back: a signing
  // key in particular is gone from the Target the moment the new one lands.
  log('')
  for (const name of which) log(`  ${CREDENTIAL_LABEL[name]} will be asked for again.`)
  if (replaceSigningKey) {
    log('  The signing key will be regenerated, and the old one will be gone.')
  }
  if (!(await prompter.confirm('\nGo ahead?', true))) {
    log('\nNothing was changed.')
    return undefined
  }

  return captureCredentials(session, log, {
    which,
    mode: 'rotate',
    replaceSigningKey,
    verifyOptions,
  })
}
