<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://www.sublang.xyz> -->

# STYLE: Authoring Conventions

This component defines authoring conventions, per [DR-000](../decisions/000-initial-specs-structure.md#dr-000-initial-specs-structure).

## Spec Format

### STYLE-001

Each spec file shall be named `<kebab-case-name>.md`.

### STYLE-002

Each item ID shall follow `<COMP>-NNN` format (e.g., AUTH-001, SPDX-003) as a markdown heading for anchor linking.

### STYLE-003

Each item shall use GEARS syntax per [META-001](../user/meta.md#meta-001) and be self-contained:

- No implicit dependency on sibling or containing sections;
- May rely on its own subsections for details;
- Cross-references to other specs or shared sections are allowed.

### STYLE-004

Item IDs shall not be modified once committed; new items shall use higher IDs.

## Cross-References

### STYLE-005

Cross-references to specific items shall use relative links with anchors (e.g., `[STYLE-001](style.md#style-001)`).

### STYLE-006

Iterations shall cite relevant specs.

### STYLE-007

Specs shall cite decisions when deriving from them.

### STYLE-008

Specs shall not cite iterations.

### STYLE-009

Test specs shall not be cited by other specs.

## SPDX Headers

### STYLE-010

Each applicable file shall include SPDX headers in the first comment block (after shebang if present), per [SPDX-001](../test/spdx-headers.md#spdx-001-copyright-header-presence) and [SPDX-002](../test/spdx-headers.md#spdx-002-license-header-presence).

**Markdown** (specs, README, docs):

```markdown
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://www.sublang.xyz> -->
```

**TypeScript/JavaScript**:

```typescript
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://www.sublang.xyz>
```
