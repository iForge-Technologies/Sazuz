# Sazuz interface captures

[← Back to the showcase](../../README.md#interface)

Captured on **5 November 2026** from the actual application in this working tree,
using Playwright Chromium and native PostgreSQL **16.15** with pgvector **0.8.6**.
The source application ran in development mode with Node.js **26.13.0**. These are
static browser screenshots, not mockups or generated illustrations.

The capture instance had its own database, account, vault, and data directory.
It contained a sample **Product research** project, two empty conversations,
and a saved **Research brief** workflow draft created through the authenticated
API. The draft was not reviewed, activated, or run. The chat composer contains
an unsent prompt. A disabled Ollama provider entry satisfied onboarding; no
model or external account was connected or called. Costs are consequently zero.

| Image                                   | Actual view                                            | Dimensions |
| :-------------------------------------- | :----------------------------------------------------- | :--------- |
| [Workspace, light](workspace-light.png) | `/chat` with sample project and unsent prompt          | 1440 × 980 |
| [Workspace, dark](workspace-dark.png)   | The same workspace using system dark appearance        | 1440 × 980 |
| [Workflow](workflow.png)                | Saved draft in `/workflows/:id`, scrolled to the graph | 1440 × 980 |
| [Agents](agents.png)                    | `/agents`, showing built-in definitions                | 1440 × 980 |
| [Recipes](recipes.png)                  | `/recipes`, showing available starter templates        | 1440 × 980 |
| [Costs](costs.png)                      | `/costs`, fresh instance with no model usage           | 1440 × 980 |
| [Settings](settings.png)                | `/settings`, General section                           | 1440 × 980 |
| [Setup](setup.png)                      | `/setup`, Welcome after token verification             | 1440 × 980 |
| [Mobile](mobile.png)                    | `/health` with real database and worker checks         | 390 × 844  |

The screenshots preserve the rendered application. No response interception,
DOM replacement, invented results, or image compositing was used. Browser motion
was reduced for stable captures. The hero uses GitHub-supported `<picture>`
sources to select the matching light or dark screenshot.

To refresh the gallery, use a disposable instance, complete real onboarding,
create representative non-sensitive records through the UI or authenticated
API, and capture these routes at the dimensions above. Wait for data and fonts,
inspect each image, and update the capture notes. Never capture setup tokens,
recovery keys, credential fields, personal accounts, or private task content.

These images establish the visible UI. They do not verify real model quality,
cloud connectors, browser automation, Docker isolation, or release installation.
