---
name: spec-idea
description: Turn an idea for INITE Brain into a well-formed GitHub issue — no code. Use when someone wants to propose, suggest or request something for Brain ("it would be great if Brain…", "can you file this idea") but not build it themselves.
---

# /spec-idea — propose an idea for INITE Brain

Goal: one clear issue a maintainer can say yes or no to. No branches, no
code. Speak plainly; explain any term you use.

1. **Restate** the idea in one or two sentences and ask at most 3
   clarifying questions (who is it for, what would they see, how would we
   know it works).
2. **Check for duplicates:** `gh issue list --search "<key words>" --state all`.
   If one exists, offer to add a comment there instead.
3. **Locate it** using the Architecture map and Zones table in `AGENTS.md`,
   so the spec names the area (MCP tools, REST API, extraction, search,
   admin UI, connectors…) and the zone. Flag red-zone touches explicitly
   (schema/migrations, auth/tokens, tenancy or per-user scope, GDPR forget,
   conflict resolution, new feature flags, eval batteries).
4. **Draft the spec** and show it:

   ```
   Problem / Behaviour / API-MCP-UI change / Data change / Risks /
   Out of scope / How we'll know it works / Zone + likely files
   ```

5. **File it** after the human says yes, using the product-idea form's
   fields (the form labels it `idea`):

   ```bash
   gh issue create --label idea --title "<plain-language title>" --body-file <spec file>
   ```

   or point them at <https://github.com/inite-ai/inite-brain-service/issues/new?template=product-idea.yml>.

6. Give the issue link and say what happens next: a maintainer triages it;
   once accepted, anyone can build it with `/contribute`.
