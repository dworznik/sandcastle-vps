# GitHub App credentials in place of the personal access token

**Ticket:** [#69](https://github.com/dworznik/sandcastle-vps/issues/69) · **Date:** 2026-09-24

## Question

#69 proposes retiring the single fine-grained personal access token the Harness holds and
injects into every Run as `GH_TOKEN`, replacing it with a GitHub App: the Harness signs a
JWT with the App's private key, mints a short-lived installation access token per Run, and
narrows that token to the Run's repository and permissions. The proposal rests on five
facts about GitHub Apps that nobody had checked against GitHub's own documentation. This
memo settles each from docs.github.com and, where the docs leave a gap, from GitHub's
changelog, so the ADR can take positions on facts rather than assumptions.

## Summary of verdicts

| Question                                  | Verdict                                                                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Multiple concurrent private keys       | Yes, up to 25; the docs do not say what deleting a key does to tokens already minted (that it only stops future minting is an inference), and every key reaches every installation. |
| 2. Rate limit: per installation or token  | Assigned to the installation, 5,000/hr scaling by repos and users to a 12,500 cap (15,000 flat on Enterprise Cloud); one shared pool is the reading, not a quote; no JWT figure.    |
| 3. Repo creation under a personal account | Not with an installation token: `POST /user/repos` accepts user access tokens and fine-grained PATs only; `POST /orgs/{org}/repos` accepts all three with Administration write.     |
| 4. App name rules                         | 34 characters, unique across GitHub, may not collide with an account you do not own, changeable later; slug-on-rename and `[bot]` removal are not documented.                       |
| 5. Mint-time narrowing                    | Yes: `repositories`/`repository_ids` (up to 500) and `permissions`, never above the installation's grant; 1 hour lifetime; revocable with `DELETE /installation/token`.             |

## 1. Multiple concurrent private keys per App

An App holds several private keys at once. The private-keys page is explicit on the
count: "You can create up to 25 private keys for an app. You should use multiple keys in
order to rotate keys without downtime in the event of a key compromise. If your
application has 25 or more keys, you must delete some before you can create more."
([Managing private keys][keys]). The 25 cap was introduced on 2024-11-08: "There is now a
limit (25) on the number of private keys a GitHub App can have registered at one time"
([changelog, 2024-11-08][cl-keys]).

Keys have no expiry: "Private keys do not expire and instead need to be manually revoked"
([Managing private keys][keys]). Deleting one requires a replacement to exist first: "You
can remove a lost or compromised private key by deleting it, but you must regenerate a new
key before you can delete the existing key." Each key is downloaded once as PEM in
`PKCS#1 RSAPrivateKey` format; GitHub keeps only the public half and shows a SHA-256
fingerprint per key.

What deletion does to credentials in flight:

- The JWT itself. The docs do not say. The JWT page says the `iss` claim "is used to find
  the right public key to verify the signature of the JWT" ([Generating a JWT][jwt]). That
  a JWT signed by a deleted key stops verifying is an inference from that sentence, not a
  documented statement; in practice a JWT lives at most 10 minutes (see "JWT and
  revocation" below), so the window is small either way.
- Installation access tokens already minted. The docs do not say. Two things point the
  same way, both inferences. First, the best-practices page prescribes separate remedies
  for a compromised key ("generate a new key or secret, update your app to use the new key
  or secret, and delete your old key or secret") and for compromised tokens ("you should
  immediately revoke these tokens", via `DELETE /installation/token`)
  ([Best practices][best]); if deleting a key revoked the tokens minted through it, the
  second instruction would be redundant. Second, since April 2026 new installation tokens
  are a GitHub-signed JWT: "The JWT is signed using a GitHub-internal issuer and cannot
  nor should not be validated by a client app" ([changelog, 2026-04-24][cl-stateless]).
  The token's validity is therefore not tied to the App private key that signed the
  minting request. Neither source states the conclusion outright.

Two documented facts cut against using keys as a per-Target revocation handle. Every key
is equal in power: "The private key for your GitHub App grants access to every account
that the app is installed on" ([Best practices][best]), so a key given to one Target can
mint tokens for every installation, not just that Target's. And the docs discourage the
pattern: "You should not generate more private keys than you need. You should delete
private keys that are no longer in use" ([Best practices][best]); the changelog gives the
reason for the cap: "sharing keys among multiple parties is not recommended, which an
unlimited number of keys lead developers towards" ([changelog, 2024-11-08][cl-keys]).

**Verdict:** An App can hold up to 25 keys at once. Whether deleting one invalidates tokens
already minted through it, the docs do not say; that it only stops future minting is an
inference from the separate remedies they prescribe, and every key reaches every
installation regardless.

**Sources:** [Managing private keys][keys], [Generating a JWT][jwt], [Best
practices][best], [changelog, 2024-11-08][cl-keys], [changelog, 2026-04-24][cl-stateless]

## 2. Rate limits: per installation or per token

The rate-limits page assigns the budget to the installation, not to the token: "GitHub
Apps authenticating with an installation access token use the installation's minimum rate
limit of 5,000 requests per hour. If the installation is on a GitHub Enterprise Cloud
organization, the installation has a rate limit of 15,000 requests per hour"
([REST API rate limits][limits]). The docs do not contain a sentence of the form "all
tokens minted from one installation share one budget"; that several actors holding
tokens from the same installation draw on one pool is the plain reading of "the
installation's minimum rate limit", and the page's structure (one limit per installation,
one per user, one per OAuth app) supports it, but it is a reading, not a quote.

The scaling rule, verbatim: "For installations that are not on a GitHub Enterprise Cloud
organization, the rate limit for the installation will scale with the number of users and
repositories. Installations that have more than 20 repositories receive another 50
requests per hour for each repository. Installations that are on an organization that
have more than 20 users receive another 50 requests per hour for each user. The rate limit
cannot increase beyond 12,500 requests per hour" ([REST API rate limits][limits]).

Checked against the #10 figure "5,000 req/hr, +50/hr per repo beyond 20, cap 12,500":

- 5,000 base, +50 per repository beyond 20, and the 12,500 cap are all as documented.
- #10 omits the second term: +50 per user beyond 20 on an organization installation.
- #10 omits the Enterprise Cloud case: a flat 15,000 with no scaling sentence attached.

User access tokens are a different regime: "Primary rate limits for GitHub App user access
tokens (as opposed to installation access tokens) are dictated by the primary rate limits
for the authenticated user. This rate limit is combined with any requests that another
GitHub App or OAuth app makes on that user's behalf and any requests that the user makes
with a personal access token" ([REST API rate limits][limits]). The `GITHUB_TOKEN` inside
Actions has its own: "1,000 requests per hour per repository".

The JWT itself, for app-level endpoints such as listing installations and minting tokens:
the docs do not say. The rate-limits page has sections for unauthenticated requests,
users, installations, OAuth apps and `GITHUB_TOKEN`, and none for JWT-authenticated
requests; the [Rate limits for GitHub Apps][app-limits] page says only that "The rate
limit for GitHub Apps depends on whether the app authenticates with a user access token or
an installation access token." The closest documented figure is a secondary limit whose
wording covers OAuth token requests: "No more than 2,000 OAuth access token requests per
hour are allowed for GitHub Apps and OAuth apps"; whether "OAuth access token requests"
includes minting installation tokens the docs do not say. Other secondary limits apply to
every caller: 100 concurrent requests, 900 points per minute per endpoint, and "no more
than 80 content-generating requests per minute and no more than 500 content-generating
requests per hour".

**Verdict:** The primary budget is assigned to the installation (5,000/hr, +50 per
repository and +50 per user beyond 20 each, capped at 12,500; 15,000 flat on Enterprise
Cloud). That everything minted from one installation draws on one pool is the plain reading
of that wording, not a sentence the docs contain, and no figure is documented for
JWT-authenticated calls.

**Sources:** [REST API rate limits][limits], [Rate limits for GitHub Apps][app-limits]

## 3. Repository creation under a personal account

The REST reference for each endpoint carries a "Fine-grained access tokens" section
naming the token types it accepts. The two differ in exactly one line.

`POST /orgs/{org}/repos`, "Create an organization repository": "This endpoint works with
the following fine-grained token types: GitHub App user access tokens, GitHub App
installation access tokens, Fine-grained personal access tokens. The fine-grained token
must have the following permission set: "Administration" repository permissions (write)"
([REST: repositories][repos-rest]). The description adds "The authenticated user must be a
member of the organization."

`POST /user/repos`, "Create a repository for the authenticated user": "This endpoint works
with the following fine-grained token types: GitHub App user access tokens, Fine-grained
personal access tokens. The fine-grained token must have the following permission set:
"Administration" repository permissions (write)" ([REST: repositories][repos-rest]).
Installation access tokens are absent from that list.

The permissions tables agree. Under "Repository permissions for "Administration"" the
GitHub Apps table lists `POST /orgs/{org}/repos` with token types UAT and IAT, and
`POST /user/repos` with UAT only ([Permissions required for GitHub Apps][perm-apps]). The
fine-grained PAT table lists both `POST /orgs/{org}/repos` and `POST /user/repos` at
access level write ([Permissions required for fine-grained PATs][perm-pat]).

So, by owner and token type:

- Organisation-owned repository: installation access token, user access token, or
  fine-grained PAT, each with Administration (write).
- User-owned repository: user access token or fine-grained PAT with Administration
  (write). An installation access token cannot do it.

A GitHub App user access token does change the answer: it can create a user-owned
repository. It is obtained through the OAuth or device flow with a human present, it acts
as that user ("your app should authenticate on behalf of a user when you want to attribute
app activity to a user", [About authentication][about-auth]), and it is short-lived:
"Installation access tokens expire after one hour, expiring user access tokens expire
after eight hours, and refresh tokens expire after six months" ([Best practices][best]).

The #69 claim that repository creation "is not among fine-grained PAT permissions" does
not hold. The PAT permissions page lists `POST /user/repos` under Administration (write),
and the endpoint page names fine-grained PATs as an accepted token type. The current PAT
can create user-owned repositories if it carries that permission.

**Verdict:** An installation access token can create repositories only under an
organisation (`POST /orgs/{org}/repos`, Administration write); user-owned repositories
need a GitHub App user access token or a fine-grained PAT, both of which the docs list for
`POST /user/repos`.

**Sources:** [REST: repositories][repos-rest], [Permissions required for GitHub
Apps][perm-apps], [Permissions required for fine-grained PATs][perm-pat], [About
authentication][about-auth], [Best practices][best]

## 4. App name rules

The registration page gives the whole documented rule in two sentences. Length and slug:
"You should choose a clear and short name. The name cannot be longer than 34 characters.
Your app's name (converted to lowercase, with spaces replaced by -, and with special
characters replaced) will be shown in the user interface when your app takes an action.
For example, My APp Näme would display as my-app-name" ([Registering a GitHub
App][register]). Uniqueness: "The name must be unique across GitHub. You cannot use the
same name as an existing GitHub account, unless it is your own user or organization name"
([Registering a GitHub App][register]).

Point by point:

- Length: 34 characters.
- Allowed characters: the docs do not give a character set. They say special characters
  are "replaced" in the slug, which implies they are accepted in the name.
- Collision with a user or organisation login: refused, unless the login is your own.
- Changing the name later: allowed. "You can change the basic information of your GitHub
  App, like the name of the app, the description of the app, and the homepage URL of the
  app" ([Modifying a GitHub App registration][modify]).
- Whether the slug changes with the name, and whether the old slug redirects: the docs do
  not say. The slug is defined as derived from the name, which suggests it follows a
  rename, but the modification page says nothing about consequences.
- The `[bot]` suffix: neither the registration page nor the modification page mentions
  it, and no setting to remove it is documented on either. That the bot user's login is
  the slug plus `[bot]` is visible in the docs only by example: the Dependabot automation
  page tests `github.event.pull_request.user.login == 'dependabot[bot]'`
  ([Automating Dependabot with GitHub Actions][dependabot-actions]). Whether it can be
  removed: the docs do not say; nothing documented suggests it can.

**Verdict:** A name is at most 34 characters, unique across GitHub and refused if it
matches an account you do not own, and can be renamed later; the docs do not document what
a rename does to the slug or any way to drop the `[bot]` suffix.

**Sources:** [Registering a GitHub App][register], [Modifying a GitHub App
registration][modify], [Automating Dependabot with GitHub Actions][dependabot-actions]

## 5. Mint-time narrowing

Yes. `POST /app/installations/{installation_id}/access_tokens` takes three optional body
fields ([REST: GitHub Apps][apps-rest]):

- `repositories`, array of strings: "List of repository names that the token should have
  access to".
- `repository_ids`, array of integers: "List of repository IDs that the token should have
  access to".
- `permissions`, object: "The permissions granted to the fine-grained access token", one
  key per permission (`contents`, `pull_requests`, `administration`, ...), each `read` or
  `write` (a few `admin`).

The endpoint description sets the defaults and the ceiling: "By default the installation
token has access to all repositories that the installation can access." "If you don't use
repositories or repository_ids to grant access to specific repositories, the installation
access token will have access to all repositories that the installation was granted
access to. The installation access token cannot be granted access to repositories that
the installation was not granted access to. Up to 500 repositories can be listed in this
manner." "If permissions is not specified, the installation access token will have all of
the permissions that were granted to the app. The installation access token cannot be
granted permissions that the app was not granted" ([REST: GitHub Apps][apps-rest]). The
narrative page repeats both ceilings verbatim ([Generating an installation access
token][iat]). Narrowed permissions therefore cannot exceed the installation's grant.

Only a JWT can call it: "You must use a JWT to access this endpoint." The endpoint "does
not work with GitHub App user access tokens, GitHub App installation access tokens, or
fine-grained personal access tokens" ([REST: GitHub Apps][apps-rest]). A Run holding only
the minted token cannot re-mint or widen it.

Lifetime: "Installation tokens expire one hour from the time you create them. Using an
expired token produces a status code of 401 - Unauthorized, and requires creating a new
installation token" ([REST: GitHub Apps][apps-rest]).

Over-asking. The documented status codes are 201 Created, 401 "Requires authentication",
403 "Forbidden", 404 "Resource not found", and 422 "Validation failed, or the endpoint has
been spammed" ([REST: GitHub Apps][apps-rest]). The docs do not say which of these is
returned when the request names a repository or permission the installation does not
have. The one documented failure message is for the complexity cap on scoped tokens:
"If the complexity limit is exceeded, the application will recieve an error: Too many
repositories for installation" ([changelog, 2024-02-22][cl-scoped]); the post gives no
status code, and the November 2024 post relaxed part of that cap while noting "The
limitation on tokens that request a subset of both permissions and tokens remains"
([changelog, 2024-11-08][cl-keys]).

Since 27 April 2026 minted tokens are the stateless `ghs_APPID_JWT` form, about 520
characters with two dots; the endpoint page warns that code expecting 40-character tokens
"may not handle this new token format correctly" ([REST: GitHub Apps][apps-rest]).

**Verdict:** A token can be narrowed at mint time to a subset of repositories (up to 500,
by name or id) and a subset of permissions, never above the installation's grant, lives
one hour, and only a JWT holder can mint it; the docs do not name the status code for
asking beyond the grant.

**Sources:** [REST: GitHub Apps][apps-rest], [Generating an installation access
token][iat], [changelog, 2024-02-22][cl-scoped], [changelog, 2024-11-08][cl-keys]

## JWT and revocation

The JWT that mints tokens: "your JWT must be signed using the RS256 algorithm"; `exp` is
"The expiration time of the JWT, after which it can't be used to request an installation
token. The time must be no more than 10 minutes into the future"; `iat` is "The time that
the JWT was created. To protect against clock drift, we recommend that you set this 60
seconds in the past and ensure that your server's date and time is set accurately"; `iss`
is "The client ID or application ID of your GitHub App" ([Generating a JWT][jwt]).

Installation access tokens can be revoked before expiry with `DELETE /installation/token`,
authenticated with the token being revoked: "Revokes the installation token you're using
to authenticate as an installation and access this endpoint. Once an installation token is
revoked, the token is invalidated and cannot be used." It returns 204, works with
"GitHub App installation access tokens" and "does not require any permissions"
([REST: installations][inst-rest]). Note the shape: the token revokes itself, so the
Harness can only revoke a Run's token if it still holds a copy.

## What this changes in the proposal

Scoring #69's assumptions:

- (a) Several concurrent keys: held, 25 at most. Revocation by key deletion: not held as
  stated. The docs do not say deletion invalidates tokens already minted, and they
  prescribe token revocation as a separate step. Worse for the design, every key "grants
  access to every account that the app is installed on", so a key is not a per-Target
  credential at all; and the docs say not to generate more keys than needed.
- (b) Rate limits per installation: held as far as the docs go, which assign the limit to
  the installation without saying "shared" outright. On that reading Targets sharing one
  installation share one budget; a Target on a different account has its own installation
  and its own budget.
- (c) Org creation via installation token with Administration write, user creation not:
  held. The corollary "so repos must live in an org" holds for the installation-token
  path only; a fine-grained PAT or a user access token can create user-owned repos, and
  the issue's claim that fine-grained PATs cannot is wrong.
- (d) Name global across GitHub: held. `[bot]` not removable: not documented either way;
  nothing suggests a switch exists. Slug behaviour on rename: not documented.
- (e) `repositories`/`permissions` at mint time: held, with the 500-repository cap and the
  ceiling of the installation's grant.
- (f) #10's figure: correct on base, per-repository step and cap; missing the per-user
  step and the flat 15,000 Enterprise Cloud figure.

The ADR has to take a position on two things:

1. What a Target is, credential-wise. Per-Target private keys do not scope anything; the
   scoping primitives GitHub offers are the installation (which account, which repos) and
   mint-time narrowing (which repos and permissions per token). Per-Target revocation is
   therefore uninstalling or narrowing the installation plus the Harness refusing to mint,
   with tokens in flight expiring within an hour or being revoked via
   `DELETE /installation/token` while a copy is still held. Whether to keep one key or
   rotate through a few is a key-hygiene question, not an isolation one.
2. Where new repositories may be created. With installation tokens only, creation is
   org-only. If Runs must create user-owned repositories, the ADR either keeps a user-side
   credential (the existing fine-grained PAT with Administration write, or a user access
   token obtained once by the owner and refreshed) or rules user-owned creation out.

## Sources

- [Managing private keys][keys] — 25 keys per App; keys do not expire; deletion needs a
  replacement first; silent on tokens in flight.
- [Generating a JWT][jwt] — RS256; `exp` at most 10 minutes; `iat` 60 seconds in the past;
  `iss` selects the public key.
- [Generating an installation access token][iat] — 1 hour lifetime; `repositories`,
  `repository_ids`, `permissions`; cannot exceed the grant.
- [Best practices][best] — a key grants access to every installation; do not create more
  keys than needed; separate remedies for key and token compromise; token lifetimes.
- [About authentication][about-auth] — installation token attributes to the app, user
  token to a user.
- [REST API rate limits][limits] — installation 5,000/hr, +50 per repo and per user beyond
  20, cap 12,500, 15,000 on Enterprise Cloud; user token limits; secondary limits.
- [Rate limits for GitHub Apps][app-limits] — limits depend on user vs installation token;
  no JWT figure.
- [REST: GitHub Apps][apps-rest] — `POST /app/installations/{id}/access_tokens` body,
  defaults, 500-repo cap, status codes, JWT-only, stateless token note.
- [REST: installations][inst-rest] — `DELETE /installation/token` revokes the calling
  token, 204.
- [REST: repositories][repos-rest] — token types and permission for the two repository
  creation endpoints.
- [Permissions required for GitHub Apps][perm-apps] — user-owned creation is UAT only;
  organisation creation is UAT and IAT.
- [Permissions required for fine-grained PATs][perm-pat] — both creation endpoints under
  Administration (write).
- [Registering a GitHub App][register] — 34 characters; slug derivation; unique across
  GitHub; no collision with accounts you do not own.
- [Modifying a GitHub App registration][modify] — the name can be changed; silent on slug
  and `[bot]`.
- [Automating Dependabot with GitHub Actions][dependabot-actions] — the `<slug>[bot]`
  login form, by example.
- [changelog, 2024-11-08][cl-keys] — the 25-key cap and its rationale; scoped-token limit
  partly relaxed.
- [changelog, 2024-02-22][cl-scoped] — 500-repository listing limit; "Too many
  repositories for installation" error.
- [changelog, 2026-04-24][cl-stateless] — stateless `ghs_APPID_JWT` tokens signed by a
  GitHub-internal issuer.

[keys]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
[jwt]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
[iat]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
[best]: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
[about-auth]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app
[limits]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[app-limits]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps
[apps-rest]: https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28
[inst-rest]: https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28
[repos-rest]: https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28
[perm-apps]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28
[perm-pat]: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens?apiVersion=2022-11-28
[register]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
[modify]: https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration
[dependabot-actions]: https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions
[cl-keys]: https://github.blog/changelog/2024-11-08-updated-limits-for-github-app-private-keys-and-scoped-tokens/
[cl-scoped]: https://github.blog/changelog/2024-02-22-new-limits-on-scoped-token-creation-for-github-apps/
[cl-stateless]: https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/
