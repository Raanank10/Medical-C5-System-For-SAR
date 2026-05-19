# Security Policy

## Supported Status

This repository is a development prototype. It is not deployed as an operational medical system.

## Reporting a Vulnerability

Open a private report through GitHub Security Advisories if available, or contact the maintainer directly.

Please include:

- affected file or feature
- reproduction steps
- expected impact
- suggested mitigation, if known

## Sensitive Data

Do not commit real patient, medical, personnel, unit, location, or operational data.

If sensitive data is accidentally committed:

1. Stop using the affected branch.
2. Notify the maintainer immediately.
3. Remove the data from the working tree.
4. Rotate any exposed secrets.
5. Rewrite public history only after explicit maintainer approval.
