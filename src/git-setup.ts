/**
 * How a container on the Target is configured to commit as the agent — the
 * one identity everything that commits there uses (ADR 0006, ADR 0007). A
 * Run's Sandbox and a Project's Session both run this, with the signing key
 * wherever each of them mounts it.
 *
 * In a file of its own, with no imports, because the creator CLI generates
 * a Session's init script from it: the Harness module that uses it for Runs
 * reads the Harness's environment when loaded, which the CLI on an operator's
 * machine does not have.
 */

/**
 * Where the signing key is mounted, read-only, inside a Sandbox.
 *
 * A bind mount carries the file's mode and owner through unchanged, and
 * `ssh-keygen -Y sign` refuses a private key that is group- or world-readable.
 * So whatever generates the key on the Target owes it mode 600 owned by the
 * operator — the same uid the Sandbox runs as, since sandcastle takes the
 * container's user from this process. The wizard's credential capture owes it
 * that (`src/cli/signing-key.ts`); this only names the file.
 */
export const SANDBOX_SIGNING_KEY_PATH = '/home/agent/.sandcastle-agent/signing_key'

/**
 * Runs as the agent user, after sandcastle's own git setup in a Sandbox and
 * at container start in a Session — so this wins where the two disagree,
 * which is the author identity sandcastle copies off the host checkout.
 *
 * Every secret is read from the environment rather than interpolated: sandcastle
 * prints each hook's command as it runs it, and a token in that string would be
 * a token in the Run's log; and a Session's copy lands on the Target's disk.
 */
export const gitSetupCommand = (signingKeyPath: string): string => `set -eu
git config --global user.name "$AGENT_GIT_NAME"
git config --global user.email "$AGENT_GIT_EMAIL"
git config --global credential.helper '!gh auth git-credential'
git config --global gpg.format ssh
git config --global user.signingkey ${signingKeyPath}
git config --global commit.gpgsign true`
