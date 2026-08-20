# IT Ops Design System

A complete reference for recreating the IT Ops visual identity across any web project.
Two complementary interfaces share a single color DNA: a **GUI dashboard** (Teletext/Ceefax-inspired) and a **TUI terminal** (CRT-emulator).

---

## 1. Design Philosophy

- **Retro-professional**: Inspired by 1980s Ceefax/Teletext broadcast pages and CRT terminal emulators
- **Zero border-radius**: Every element has sharp corners (`border-radius: 0`). The only exception is live-status dots (circles)
- **Monospace everywhere**: All text uses monospace fonts — no proportional fonts anywhere
- **Dark-first**: Pure black backgrounds, no light mode
- **Information-dense**: Compact spacing, uppercase labels, no decorative whitespace
- **No shadows, no gradients** (except CRT effects): Flat design throughout

---

## 2. Color Palette

### 2.1 Core 8-Color Palette (Softened Teletext)

These are the primary brand colors, softened from pure Teletext neons for screen readability:

| Name    | Hex       | Role                                      |
|---------|-----------|-------------------------------------------|
| Black   | `#000000` | Primary background                        |
| White   | `#e8e8d8` | Primary text (warm off-white)             |
| Cyan    | `#44aaaa` | Accent, links, interactive elements       |
| Yellow  | `#ccaa33` | Labels, section headers, nav icons        |
| Green   | `#33aa55` | Success states, online indicators         |
| Red     | `#cc3333` | Danger, errors, critical alerts           |
| Blue    | `#224488` | Header bars, stat cards, table headers    |
| Magenta | `#aa44aa` | Special badges (production, rolled-back)  |

### 2.2 GUI Variables (theme.css)

Used by the sidebar dashboard pages:

```css
:root {
  /* Backgrounds — layered darkest to lightest */
  --bg:           #000000;   /* page background */
  --bg2:          #0a0a0a;   /* cards, panels */
  --bg3:          #151515;   /* table headers, stat cards, nested panels */
  --bg4:          #222222;   /* hover states */

  /* Borders */
  --border:       #444444;   /* primary borders */
  --border2:      #555555;   /* hover borders */

  /* Text — three tiers */
  --text:         #e8e8d8;   /* primary (warm off-white) */
  --text2:        #aaaaaa;   /* secondary (muted) */
  --text3:        #666666;   /* tertiary (disabled, timestamps) */

  /* Accent (cyan) */
  --accent:       #44aaaa;
  --accent-light: #66cccc;
  --accent-bg:    #112828;   /* subtle tinted background */
  --accent-border:#44aaaa;

  /* Semantic status colors */
  --success:      #33aa55;
  --success-bg:   #112211;
  --warning:      #ccaa33;
  --warning-bg:   #222211;
  --danger:       #cc3333;
  --danger-bg:    #221111;
  --info-bg:      #111122;

  /* Shape — everything sharp */
  --radius:       0px;
  --radius-sm:    0px;
  --radius-md:    0px;
  --radius-lg:    0px;
  --shadow:       none;
  --shadow-lg:    none;
}
```

### 2.3 TUI Variables (terminal pages)

Used by the terminal emulator pages:

```css
:root {
  --t-bg:         #0a0a0a;   /* terminal background */
  --t-fg:         #33ff99;   /* primary text (phosphor green) */
  --t-dim:        #1a6644;   /* dimmed/muted text */
  --t-cyan:       #44aaaa;   /* prompts, headers, commands */
  --t-yellow:     #ccaa33;   /* labels, panel headers */
  --t-red:        #cc3333;   /* errors */
  --t-blue:       #4488cc;   /* info, running states */
  --t-white:      #e8e8d8;   /* message body text */
  --t-border:     #1a3322;   /* subtle green-tinted borders */
  --t-highlight:  #112818;   /* row hover, selection */
  --bar-bg:       #001a0d;   /* bar backgrounds (top bar, input bar, status bar) */
}
```

### 2.4 Switchable TUI Themes

The terminal supports runtime theme switching. Each theme redefines `--t-fg`, `--t-dim`, `--t-border`, `--t-highlight`, and `--bar-bg`:

| Theme | Foreground | Dim       | Border    | Highlight | `--bar-bg`  |
|-------|-----------|-----------|-----------|-----------|-------------|
| Green | `#33ff99` | `#1a6644` | `#1a3322` | `#112818` | `#001a0d`   |
| Amber | `#ffaa33` | `#664411` | `#332211` | `#1a1108` | `#0d0800`   |
| Blue  | `#44aaff` | `#1a4466` | `#0d2233` | `#081620` | `#000d1a`   |
| White | `#e8e8d8` | `#555555` | `#333333` | `#1a1a1a` | `#0a0a0a`   |

---

## 3. Typography

### 3.1 Font Stack

| Context       | Font                                          |
|---------------|-----------------------------------------------|
| GUI pages     | `"Courier New", "Consolas", monospace`        |
| TUI pages     | `"JetBrains Mono", monospace` (Google Fonts)  |
| Login page    | `"Courier New", "Consolas", monospace`        |

### 3.2 Size Scale

| Use                    | Size  | Weight | Transform       |
|------------------------|-------|--------|-----------------|
| Page title             | 16px  | bold   | none            |
| Section header         | 14px  | bold   | uppercase       |
| Body text / nav items  | 13px  | normal | none            |
| Table cells            | 13px  | normal | none            |
| Subtitle / meta        | 12px  | normal | none            |
| Table headers          | 11px  | bold   | uppercase       |
| Section labels         | 11px  | bold   | uppercase       |
| Badges                 | 11px  | bold   | uppercase       |
| Timestamps / tertiary  | 10-11px | normal | none          |

### 3.3 Letter Spacing

- Section headers: `0.06em`
- Table headers: `0.05em`
- Logo: `0.08em`
- TUI top bar: `0.1em`

---

## 4. GUI Components

### 4.1 Sidebar

- Width: defined by `design.css` base (typically ~200px)
- Background: `#000`
- Border-right: `1px solid #444`
- **Logo bar**: `background: #224488`, text: `#e8e8d8`, bold, 15px
- **Section labels**: `background: #1a1a1a`, text: `#ccaa33` (yellow), 11px, uppercase, bold
- **Nav items**: text: `#44aaaa` (cyan), 13px, `padding: 6px 14px`, bottom border `1px solid #1a1a1a`
- **Nav icons**: fixed `width: 18px`, `color: #ccaa33`, centered, ASCII characters
- **Active item**: `background: #111`, `color: #e8e8d8`, left border `3px solid #44aaaa`
- **Hover**: `background: #222`, `color: #e8e8d8`
- **Footer**: pinned at bottom with `flex-shrink: 0`, styled identically to nav items
- **Scroll**: nav area scrolls independently (`flex: 1; overflow-y: auto`), thin scrollbar

### 4.2 Page Header

- Background: `#224488` (blue)
- Padding: `10px 20px`
- Title: `#e8e8d8`, 16px, bold
- Subtitle: `#44aaaa`, 12px

### 4.3 Cards

- Background: `#0a0a0a`
- Border: `1px solid #444`
- No shadow, no border-radius
- Hover: border changes to `#555`

### 4.4 Stat Cards

- Background: `#224488` (blue) — stands out from page
- No border
- Number: 22px, bold, `#66cccc` (accent-light)
- Label: 11px, `#aaaaaa`, uppercase

### 4.5 Tables

- Outer border: `1px solid #444`
- Header row: `background: #224488`, text: `#ccaa33`, 11px, uppercase
- Cell padding: `6px 12px`
- Row border: `1px solid #222`
- Row hover: `background: #111`

### 4.6 Buttons

- Primary: `background: #44aaaa`, `color: #000`, bold, uppercase, 13px
- Primary hover: `background: #e8e8d8`
- Outline/Ghost: transparent, `border: 1px solid #444`, `color: #44aaaa`
- Danger: `background: #cc3333`, `color: #e8e8d8`

### 4.7 Inputs

- Background: `#111`
- Border: `1px solid #444`
- Focus: `border-color: #44aaaa`, no outline, no shadow
- Font: monospace, same as body

### 4.8 Badges

- Inline-block, `padding: 1px 6px`, 11px, bold
- Border-style (outlined, not filled): `border: 1px solid <color>; color: <color>`
- Success: green border + text
- Error: red border + text
- Info: cyan border + text

### 4.9 Tabs

- Background: `#111`
- Tab button: `border-right: 1px solid #333`, `color: #44aaaa`, bold, 13px
- Active tab: `background: #44aaaa`, `color: #000`
- Hover: `background: #222`, `color: #e8e8d8`

---

## 5. TUI Components

### 5.1 CRT Effects

Two pseudo-element overlays on `body` create the retro CRT look:

**Scanlines** (`body::after`):
```css
background: repeating-linear-gradient(
  0deg,
  transparent,
  transparent 2px,
  rgba(0,0,0,0.08) 2px,
  rgba(0,0,0,0.08) 4px
);
pointer-events: none;
z-index: 9999;
```

**Vignette** (`body::before`):
```css
background: radial-gradient(
  ellipse at center,
  transparent 60%,
  rgba(0,0,0,0.4) 100%
);
pointer-events: none;
z-index: 9998;
```

Both are `position: fixed` covering the full viewport.

### 5.2 Terminal Layout

Four-band vertical layout with a **double top bar** (all `flex-shrink: 0` except the terminal area):

1. **Title bar**: `background: #224488` (blue), `padding: 6px 16px`. Left side: `[=] IT OPS` in bold white `#e8e8d8`. Right side: clock in cyan `#44aaaa`
2. **Nav bar**: `background: var(--bar-bg)` (`#001a0d`), `border-bottom: 1px solid var(--t-border)`, horizontal nav links. Links: `color: var(--t-cyan)`, `padding: 5px 14px`, `border-right: 1px solid var(--t-border)`. Active link: `background: var(--t-cyan)`, `color: #000`, bold. Right-aligned links use `border-left` instead of `border-right`
3. **Terminal output**: `flex: 1; overflow-y: auto; padding: 12px 16px`
4. **Input bar**: `background: var(--bar-bg)`, `border-top: 1px solid var(--t-border)`, `padding: 8px 16px`
5. **Status bar**: `background: var(--bar-bg)`, `padding: 3px 16px`, 11px, `color: var(--t-dim)`

### 5.3 Terminal Output Lines

- Font size: 13px
- Line height: 1.6
- `white-space: pre-wrap; word-break: break-all`
- Color classes: `.dim`, `.cyan`, `.yellow`, `.red`, `.blue`, `.white`, `.bold`
- Header lines: cyan, bold, bottom border `1px solid var(--t-border)`

### 5.4 Terminal Tables

- Rendered as flex rows (not HTML `<table>`)
- Header row: `color: var(--t-yellow)`, bold, `border-bottom: 1px solid var(--t-border)`
- Data rows: `border-bottom: 1px solid #0d1f14`
- Row hover: `background: var(--t-highlight)`
- Cells: fixed widths, `overflow: hidden; text-overflow: ellipsis`

### 5.5 Input Bar

- Prompt label: cyan, bold, 13px (e.g., `itops>`)
- Input field: transparent background, no border, `color: var(--t-fg)`, monospace
- Blinking cursor block: 8x15px, `background: var(--t-fg)`, `animation: blink 1s step-end infinite`

### 5.6 Status Badges (Inline)

Color-coded inline spans for status values in terminal output:

```css
.s-ok   { color: #33aa55; }  /* active, online, healthy, success */
.s-warn { color: #ccaa33; }  /* warning, degraded, pending, idle */
.s-err  { color: #cc3333; }  /* critical, error, failure, offline */
.s-info { color: #44aaaa; }  /* default/fallback */
.s-run  { color: #4488cc; }  /* running, deploying, in_progress */
```

Format: `[STATUS]` wrapped in colored span.

### 5.7 Chat Split View

- Left panel (agent list): `width: 200px`, `background: #050a07`, `border-right: 1px solid var(--t-border)`
- Right panel (messages): `flex: 1`
- Agent items: `padding: 6px 12px`, 12px font, bottom border `#0d1f14`, status dot (6px circle)
- Selected agent: `border-left: 2px solid var(--t-cyan)`, highlighted background
- Messages are a single line: `sender_name  message_text` with timestamp displayed below
- Color coding: user=cyan (`--t-cyan`), agent=yellow (`--t-yellow`), system=dim (`--t-dim`)

### 5.8 Navigation Bar

Shared TUI nav bar pattern used across all TUI pages for consistency:

- **Left-side tabs**: TERMINAL, CHAT, BRIDGE, INCIDENTS, SERVERS
- **Right-side tabs**: GUI, LOGIN
- Active tab is highlighted with cyan background (`background: var(--t-cyan)`, `color: #000`, bold)
- Inactive tabs: `color: var(--t-cyan)`, separated by `border-right: 1px solid var(--t-border)` (left-side) or `border-left` (right-side)
- All TUI pages share the same nav bar for visual and navigational consistency

---

## 6. Login Page

- Centered vertically and horizontally on pure black background
- Card: `max-width: 380px`, `background: #0a0a0a`, `border: 1px solid #444`
- Header: `background: #224488`, centered, same as page headers
- Labels: `#ccaa33` (yellow), 11px, uppercase, bold
- Inputs: `background: #111`, `border: 1px solid #444`, focus: cyan border
- Button: full-width, `background: #44aaaa`, `color: #000`, bold, uppercase
- Error display: `background: #221111`, `border: 1px solid #cc3333`, `color: #cc3333`

---

## 7. Navigation Architecture

### 7.1 ASCII Nav Icons

Each sidebar item has a single ASCII character icon in yellow:

| Icon | Page         |
|------|--------------|
| `!`  | Incidents    |
| `>`  | Workflows    |
| `#`  | Runbooks     |
| `@`  | Servers      |
| `%`  | Monitoring   |
| `*`  | Jira         |
| `&`  | A2A Mesh     |
| `$`  | Agents       |
| `~`  | Scheduler    |
| `^`  | Security     |
| `+`  | Users        |
| `<`  | Agent Chat   |
| `<>` | Agent Bridge |
| `=`  | Dashboard    |
| `|`  | CI/CD        |
| `.`  | Audit        |
| `:`  | RBAC         |
| `,`  | Plugins      |

### 7.2 Sidebar Sections

Grouped by function:
1. **Operations**: Incidents, Workflows, Runbooks, Servers, Monitoring
2. **Integrations**: Jira, A2A Mesh
3. **System**: Agents, Scheduler, Security, Users (admin-only)
4. **Communication**: Agent Chat, Agent Bridge
5. **Tools**: Dashboard, CI/CD, Audit, RBAC, Plugins

---

## 8. Responsive / Mobile

- At `max-width: 768px`, sidebar converts to bottom navigation bar
- Sidebar: `border-top: 1px solid #444` replaces `border-right`
- Nav items: horizontal, `border-right: 1px solid #1a1a1a` replaces `border-bottom`
- TUI: padding reduces, font drops to 11px at `max-width: 600px`

---

## 9. Scrollbar Styling

Consistent thin scrollbars throughout:

```css
/* GUI */
::-webkit-scrollbar       { width: 6px; }
::-webkit-scrollbar-track { background: #000; }
::-webkit-scrollbar-thumb { background: #444; }
::-webkit-scrollbar-thumb:hover { background: #666; }

/* TUI */
scrollbar-width: thin;
scrollbar-color: var(--t-dim) var(--t-bg);
::-webkit-scrollbar       { width: 4px; }
::-webkit-scrollbar-track { background: var(--t-bg); }
::-webkit-scrollbar-thumb { background: var(--t-dim); }
```

---

## 10. File Structure

```
public/
  design.css        Base layout system (sidebar grid, responsive)
  theme.css         Teletext color overrides (load AFTER design.css)
  auth-guard.js     Auth check + sidebar user population
  login.html        Standalone login page
  tui.html          Terminal emulator interface
  tui-chat.html     Terminal-style agent chat (split view)
  dashboard-legacy.html   Main GUI dashboard
  *.html            All other GUI pages (sidebar + theme.css)
```

### CSS Load Order

```html
<link rel="stylesheet" href="/design.css">   <!-- base layout -->
<link rel="stylesheet" href="/theme.css">    <!-- teletext overrides -->
```

TUI pages are self-contained (no design.css/theme.css — they have their own inline styles).

---

## 11. Quick-Start Checklist

To recreate this design on a new project:

1. Set `background: #000` on body, `color: #e8e8d8`
2. Set `font-family: "Courier New", "Consolas", monospace` (or JetBrains Mono for TUI)
3. Set `border-radius: 0` globally
4. Use `#224488` for headers/stat cards
5. Use `#44aaaa` for accent/links, `#ccaa33` for labels, `#33aa55`/`#cc3333` for status
6. Use `1px solid #444` for borders
7. Use `#0a0a0a` for card backgrounds, `#111` for inputs
8. All text: uppercase + bold for labels, normal weight for content
9. No shadows, no gradients, no border-radius
10. For TUI: add scanline + vignette pseudo-elements, use `#33ff99` as primary text
