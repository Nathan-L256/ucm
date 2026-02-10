You are analyzing a completed software engineering task to extract lessons learned.

## Task

**Title:** {{TASK_TITLE}}

## Timeline

{{TIMELINE}}

## Summary

{{SUMMARY}}

## Instructions

Extract lessons from this task — specifically "problem → solution" patterns that would help avoid repeating mistakes or speed up similar tasks in the future.

Output format — produce a markdown file with YAML frontmatter:

```
---
task: {task title}
date: {ISO date}
category: project | general
tags: [relevant, tags]
severity: low | medium | high
prevention: {재발 방지를 위한 구체적 조치}
---

## Lesson 1: {short title}

**Problem:** {what went wrong or was difficult}
**Solution:** {what fixed it or would fix it}
**Context:** {when this lesson applies}
**Severity:** low | medium | high
**Prevention:** {시스템/템플릿/설정 변경으로 재발 방지 가능한 방법}

## Lesson 2: ...
```

Rules:
- Only extract genuine lessons (failure→retry→success, unexpected blockers, non-obvious solutions)
- Mark lessons as `category: project` if they are specific to this project's codebase/tooling
- Mark lessons as `category: general` if they apply broadly to software engineering
- If there are no meaningful lessons (everything went smoothly), output only the frontmatter with an empty body
- Keep each lesson concise (2-3 sentences per field)
