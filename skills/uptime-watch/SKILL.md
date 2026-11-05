---
name: uptime-watch
description: Check a public endpoint and report supplied certificate or domain expiry dates without inventing monitoring data.
version: 1.0.0
inputs:
  type: object
  properties:
    url:
      type: string
    expiryNotes:
      type: string
  required: [url]
  additionalProperties: false
tools: [time.now, web.fetch]
permissions: [read]
---

# Uptime, SSL and Domain Watch

Read the current time and fetch the configured public HTTP(S) endpoint once. Report the observed HTTP status, timestamp and any fetch failure. A successful request is evidence of reachability for that check, not a continuous uptime guarantee.

Compare certificate/domain expiry dates only when supplied by the user or supported by an explicitly configured official source. The initial HTTP tool does not expose certificate expiry or domain registration metadata. Mark those checks unavailable when evidence is missing.

Never bypass certificate errors, logins, CAPTCHAs or private-network restrictions. Return the finding through the existing mission and notification flow; do not add new notification recipients.
