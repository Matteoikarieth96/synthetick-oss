# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting: open the **Security** tab of this repository, choose **Report a vulnerability**, and describe what you found.
Include steps to reproduce and what an attacker could do. You will get a first answer within 7 days.

We care most about: credential or key exposure, authentication or credit bypass, SSRF or injection, anything that makes the service spend money on someone else's behalf, and database access without the service key.

## Ground rules for researchers

- Test against your own deployment, not against synthetick.org, and never against other people's accounts or data.
- Do not run load tests or automated scanners against the production service.
- Give us reasonable time to fix a problem before you publish details.

## Secrets in this repository

This repository must never contain a real key, token, wallet file or `.env`. A secret scan (gitleaks) runs on every push and pull request.
If you find a secret that slipped through, report it privately as above and we will rotate it.
