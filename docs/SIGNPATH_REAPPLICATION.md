# SignPath Foundation re-application evidence

Updated: 2026-08-23

This page is the public, reproducible evidence package for AgentPlay's free open-source code-signing re-application. It contains no credentials or private application data. Approval remains solely at SignPath Foundation's discretion.

## Project identity

- Project: AgentPlay
- Repository and homepage: <https://github.com/wg5759/AgentPlay>
- Public download: <https://github.com/wg5759/AgentPlay/releases/tag/v0.7.6>
- License: Apache License 2.0 for project-owned source; bundled upstream components retain their own open-source licenses as recorded in `THIRD_PARTY_NOTICES.md`.
- Maintainer, committer and reviewer: [wg5759](https://github.com/wg5759)
- Signing approver: [wg5759](https://github.com/wg5759)
- Privacy policy: [PRIVACY.md](../PRIVACY.md)
- Code signing policy: [README.md](../README.md#code-signing-policy)

## Honest reputation evidence

The first application, submitted on 2026-07-21, was declined on 2026-07-23 because the public project did not yet have sufficient visible adoption or reputation. The project does not present maintainer-created Issues, Discussions, CI runs, bot activity, views or clones as independent community adoption.

Public facts available for re-review:

- The repository has been public since 2026-07-16 and is actively maintained.
- The current stable public release is `v0.7.6`, published on 2026-08-10 in the same Windows installer form that the project intends to sign.
- That release contains a Windows installer, SPDX 2.3 SBOM, security-scan report, verification report and SHA-256 checksums. The installer has recorded public downloads.
- The repository now has one genuine non-maintainer Star (`fayyi`) and one genuine non-maintainer Fork (`TheThingInTheThing`). The fork has no commits ahead of upstream; this is stated honestly rather than presented as a contribution.
- GitHub Discussions, structured Issue Forms, support guidance, a five-minute quick start and contribution guidance are public.
- Ubuntu and Windows GitHub-hosted quality jobs, production and complete dependency audits, source checks and release security scans are reproducible. The 2026-08-23 candidate head passed both jobs in [Actions run 32614121530](https://github.com/wg5759/AgentPlay/actions/runs/32614121530).
- Public GPL compliance evidence for bundled mpv includes a pinned binary archive, manifest and complete corresponding source: <https://github.com/wg5759/AgentPlay/releases/tag/mpv-gpl-v0.41.0-20260719>.

This is still a small project. One Star and one Fork are evidence of external discovery, not proof of broad adoption. The application asks SignPath Foundation to re-evaluate the project using the complete released, documented and verifiable-build record.

## Security, privacy and release controls

- AgentPlay contains no analytics, advertising or crash-telemetry SDK.
- Local files remain local unless the user explicitly chooses a network function or approves a cloud-model task. Cloud, paid, publish, delete and credential actions use a unified approval protocol.
- API keys and signing credentials are excluded from source, logs, Issues and release assets.
- The installer provides uninstallation and announces system integrations such as file associations.
- Every release-signing request requires a human approver. No tag push automatically publishes a Release.
- The signing workflow runs only on GitHub-hosted Windows agents, uploads the unsigned workflow artifact to GitHub before submission, and uses SignPath's current `github-action-submit-signing-request@v2` integration.
- Third-party executables such as mpv are included with license and provenance evidence but must not be signed as AgentPlay-owned binaries.

## Requested free service

AgentPlay requests the free OSS SignPath.io subscription and a certificate issued to SignPath Foundation. No paid certificate route is requested or planned.

After approval, the maintainer will create the SignPath project, artifact configuration and release-signing policy; install the official SignPath GitHub App; store the API token only as a GitHub Actions secret; configure non-secret organization/project/policy slugs as repository variables; and manually approve every signing request.

The first stable signed release will be produced only after the corresponding source PR is merged, the package version is frozen, GitHub-hosted Windows and Ubuntu gates are green, and the signing artifact configuration has been reviewed to sign only AgentPlay-owned PE files.

## Proposed form answers

### Project description

AgentPlay is an Apache-2.0, local-first Windows desktop media and content workstation built with Electron. It combines reliable local playback, user-authorized video downloading, real-time or generated subtitles, evidence-based video breakdown reports, document workflows, natural-language non-destructive media editing and open model integration. Network and cloud functions are explicit, reviewable actions; the application does not include analytics, advertising or crash telemetry.

### Repository and download URLs

- Repository/homepage: `https://github.com/wg5759/AgentPlay`
- Download: `https://github.com/wg5759/AgentPlay/releases/tag/v0.7.6`
- Re-application evidence: `https://github.com/wg5759/AgentPlay/blob/master/docs/SIGNPATH_REAPPLICATION.md` (available after merge)

### Build and reputation statement

Windows artifacts are built from the public repository on GitHub-hosted runners. Unsigned artifacts are uploaded to GitHub Actions before the SignPath signing request, allowing SignPath to verify repository, workflow and commit origin. Releases include an SPDX SBOM, security scan, verification report and SHA-256 list. Since the prior rejection the repository has shipped a complete public Windows release, enabled Discussions and structured contribution/support entry points, retained green Ubuntu/Windows gates, and gained one genuine external Star and one genuine external Fork. We do not claim those two signals as broad adoption or external contribution.

## Remaining human-only fields

The public repository deliberately does not store the applicant's personal contact name, email address, phone number or SignPath account identifiers. Those values must be supplied by the maintainer in the official application form and must never be committed.
