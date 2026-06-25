# Corral Design System

Single source of truth for Corral's visual language, shared across the **PC application**
(desktop orchestrator) and the **mobile app** (control + sync companion).

> Principle: **one accent, two surfaces.** The coral accent, type scale, iconography, and
> status semantics are identical on every platform. Only layout density and navigation differ.

---

## 1. Brand

- **Name:** Corral — a pen/enclosure where AI agents are herded into a human-controlled space.
- **Color story:** the Korean reading of *corral* (코랄) is also *coral*. Coral is therefore the
  signature **accent**, never the base — it earns its place from the name.
- **Mark metaphor:** an enclosure holding an agent node (recommended: the "C enclosure" — a C-shaped
  pen that doubles as the initial). Form = enclosure, color = coral.
- **Voice of the UI:** calm, technical, infrastructure-grade. Coral is a spark, not a flood.

---

## 2. Color tokens

Dark is the primary theme (developer tool); light is fully supported. Use tokens, never raw hex.

### Accent · Coral (interactive + brand only — keep under ~10% of any screen)

| Token | Hex | Use |
|-------|-----|-----|
| `--accent-50`  | `#FFE3DE` | tint: hover bg, selected row, subtle highlight |
| `--accent-500` | `#FF6B5B` | brand mark, primary button, active/focus, links |
| `--accent-600` | `#E8503F` | primary hover |
| `--accent-700` | `#C7402F` | pressed, and text/icon on `--accent-50` |

### Base · Neutral (slate — everything structural)

| Token | Hex | Use |
|-------|-----|-----|
| `--ink-900` | `#0F172A` | dark UI base background |
| `--ink-800` | `#1E293B` | dark surfaces, panels, cards |
| `--ink-700` | `#334155` | dark borders, dividers |
| `--ink-500` | `#64748B` | secondary text |
| `--ink-300` | `#CBD5E1` | light-mode borders |
| `--ink-100` | `#E2E8F0` | primary text on dark |
| `--ink-50`  | `#F8FAFC` | light UI base background |
| `--white`   | `#FFFFFF` | light surfaces, cards |

### Semantic · Status

| Token | Hex | Meaning |
|-------|-----|---------|
| `--info`    | `#378ADD` | running / in-progress (agent working) |
| `--success` | `#1D9E75` | passed / merged / approved |
| `--warning` | `#BA7517` | awaiting human input / escalated |
| `--danger`  | `#DC2626` | failed / blocker / destructive action |

> ⚠️ Coral and danger-red are both warm. **Reserve coral for brand/primary actions only; use
> `--danger` strictly for errors and destructive actions.** Never place a coral button next to a
> red one, and never use coral to signal an error.

### Mapping to orchestrator phases (PC dashboard)

| Phase | Color |
|-------|-------|
| planning / plan_reviewing / implementing / review_fixing | `--info` |
| plan_sent / review_sent / question_sent (awaiting human) | `--warning` (gate accent uses `--accent-500`) |
| pr_open / done | `--success` |
| failed / auth_error | `--danger` |

---

## 3. Typography

- **UI font:** Inter (fallback: system-ui). **Code/IDs/logs:** a monospace (JetBrains Mono / ui-monospace).
- **Weights:** 400 regular, 500 medium, 600 semibold (headings/emphasis only). Sentence case everywhere.

| Style | Size / Line | Weight |
|-------|-------------|--------|
| display | 28 / 36 | 600 |
| h1 | 22 / 30 | 600 |
| h2 | 18 / 26 | 600 |
| h3 | 16 / 24 | 500 |
| body | 14 / 22 | 400 |
| small | 13 / 20 | 400 |
| caption | 12 / 16 | 400 |
| mono | 13 / 20 | 400 (monospace) |

---

## 4. Spacing, radius, borders

- **Spacing scale (4px base):** 4, 8, 12, 16, 24, 32, 48. Use for padding, gaps, vertical rhythm.
- **Radius:** `sm 6` (inputs, chips) · `md 8` (buttons, cards) · `lg 12` (panels, modals) · `pill 999`.
- **Borders:** 1px hairline using `--ink-700` (dark) / `--ink-300` (light). No drop shadows for
  structure — use borders + surface elevation. Shadows only for true overlays (modals, menus).

---

## 5. Iconography

- **Style:** outline, 1.5px stroke, 24px grid, rounded joins (Tabler/Lucide-compatible). Monochrome,
  inherits text color. Coral only on the brand mark and active states.
- **Brand mark:** the Corral enclosure. Ship SVG set: light/dark, favicon (16/32), app icon, wordmark.

---

## 6. Components (shared primitives)

| Component | Notes |
|-----------|-------|
| Button | `primary` = coral fill, white text · `secondary` = outline (ink border, transparent) · `ghost` = text only. Heights 36 (default) / 32 (compact). |
| Input / Select / Textarea | 36px, hairline border, focus ring = `--accent-500`. |
| Card / Panel | surface bg, hairline border, radius `lg`, padding 16. |
| Badge / Status pill | semantic color from §2; text uses the darker stop of the same family. |
| Approval gate banner | the human touch-point. Surface + left accent bar in `--accent-500`, with approve/feedback actions. The one place coral is prominent. |
| Timeline / log | collapsible, mono for log lines, phase dot colored per §2 mapping. |
| Nav item | active = coral text/indicator; rest neutral. |
| Modal / Toast | overlay with shadow; success/danger toasts use semantic colors. |

---

## 7. Platform guidance

**Shared (identical on both):** color tokens, type scale, iconography, status semantics, radius, the
coral accent and its ≤10% rule.

### PC application — desktop orchestrator
- Information-dense. Dark theme default.
- Layout: action panel + run timeline + progress indicators + collapsible logs (multi-column).
- Current template-based UI is acceptable until user count grows; tokens above still apply so the
  later redesign is a re-skin, not a rebuild.

### Mobile app — control + sync companion
- Focused, not dense. Single column, bottom nav.
- Core jobs: monitor runs, act on approval gates, view sync status. No full orchestration authoring.
- Needs full wireframes + component library in Figma before build (see §8).

---

## 8. Figma structure (file: Corral)

Build foundations first, then components, then screens (mind starter-tier rate limits).

1. **Color styles:** `accent/50…700`, `ink/50…900`, `semantic/info|success|warning|danger`.
2. **Variables (modes: Light / Dark):** `bg`, `surface`, `text`, `text-muted`, `border`, `accent`.
3. **Text styles:** display, h1, h2, h3, body, small, caption, mono.
4. **Components:** Button (variants), Input, Card, Badge/StatusPill, ApprovalBanner, NavItem.
5. **Screens:** PC dashboard frames, then mobile app flows (monitor → approve → sync).

Keep Figma style/variable names matching the token names in §2–§4 so design and code stay in sync.
