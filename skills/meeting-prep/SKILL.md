---
name: meeting-prep
description: Prepare an agenda brief from an identified meeting, relevant past threads and public attendee information.
version: 1.0.0
inputs:
  type: object
  properties:
    meeting:
      type: string
  required: [meeting]
  additionalProperties: false
tools:
  [calendar.list, email.list, email.read, gmail.list, gmail.read, web.search, web.fetch, kb.search]
permissions: [read]
---

# Meeting Prep

Identify the meeting and its date before researching. Use Researcher for public company information and project knowledge, and Comms for relevant email/calendar context. Restrict research to the stated meeting and participants.

Provide the purpose, attendee context, a proposed agenda, open questions and any commitments supported by source records. Cite source chunks and public URLs. Mark missing or conflicting evidence.

Return a brief in the mission. Do not send mail, change the calendar or infer sensitive personal attributes. Calendar-relative triggers are a later capability; this skill works with manual runs and explicit schedules.
