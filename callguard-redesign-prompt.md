# CallGuard UI Redesign — Claude Code Instructions

Copy this entire prompt into Claude Code from your CallGuard project root directory.

---

## Prompt

Redesign the CallGuard frontend to match the design system defined below. The app is a React/Vite project. Apply these changes across ALL existing pages and components. Use the reference file `callguard-demo.html` (in my outputs folder) as the visual target — every screen in the app should match that demo's look and feel.

### Design Tokens

**Colours:**
- Primary (sage green): `#4a9e6e`
- Primary hover: `#3d8a5e`
- Primary light bg: `#e8f0e8`
- Primary light hover: `#f0f5f0`
- Page background: `#f8faf8`
- Card/panel background: `#ffffff`
- Border: `#e2e8e2`
- Light border: `#f0f5f0`
- Text primary: `#1a2e1a`
- Text secondary: `#5a6e5a`
- Text muted: `#8a9e8a`
- Text subtle: `#6a7e6a`
- Icon muted: `#aabdaa`
- Fail/error: `#c0392b`
- Fail background: `#fde8e8`
- Warning/review: `#b8860b`
- Warning background: `#fef3e0`
- Pass/success: `#2d6e4a`
- Pass background: `#e8f5e8`
- Processing: `#2d5a9e`
- Processing background: `#e8f0fa`
- Secondary bar chart: `#7ec49e`

**Typography:**
- Font family: `'Inter', -apple-system, sans-serif`
- Import: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap')`
- Page title: 22px, weight 700, letter-spacing -0.3px
- Page subtitle: 14px, color `#6a7e6a`
- Card label: 12px, weight 600, uppercase, letter-spacing 0.5px, color `#8a9e8a`
- Card value: 30px, weight 700
- Table header: 11px, uppercase, letter-spacing 0.5px, weight 600, color `#8a9e8a`, bg `#fafcfa`
- Table cell: 13px, color `#3a4e3a`
- Nav item: 14px, weight 500
- Nav active: weight 600, color `#2d6e4a`
- Nav label (section heading): 11px, uppercase, letter-spacing 0.8px, color `#8a9e8a`, weight 600

**Spacing & Layout:**
- Sidebar width: 220px, fixed left
- Main content: `margin-left: 220px`, padding `32px 36px`, max-width 1200px
- Card padding: 20px
- Card border-radius: 10px
- Button border-radius: 8px
- Nav item padding: `9px 12px`, border-radius 8px
- Stats row: 4-column grid, 16px gap
- Charts row: 2-column grid, 16px gap

**Components:**

1. **Sidebar** — White background, 1px right border. Logo at top (32px green circle with bell SVG icon + "CallGuard" text). Nav items with 18px SVG stroke icons. Active nav item has `#e8f0e8` background. Footer shows user name, email, and sign-out link with a small SVG icon.

2. **Stat Cards** — White card with border, label in uppercase muted text with an 18px SVG icon on the right, large numeric value, and a small green change indicator below (e.g. "+12% from last week"). Red for negative changes.

3. **Panels/Tables** — White card with border-radius 10px. Panel header has 15px weight-600 title on left and a green link on right (e.g. "View all"). Table rows are clickable with hover state `#fafcfa`.

4. **Status Badges** — Pill-shaped (`border-radius: 20px`, `padding: 3px 10px`, 11px weight-600):
   - Pass: green bg `#e8f5e8`, text `#2d6e4a`
   - Fail: red bg `#fde8e8`, text `#c0392b`
   - Review: amber bg `#fef3e0`, text `#b8860b`
   - Processing: blue bg `#e8f0fa`, text `#2d5a9e`

5. **Score Bars** — Inline 50px wide, 5px tall bar with 3px border-radius. Fill colours: high (green `#4a9e6e`), mid (amber `#d4a017`), low (red `#c0392b`).

6. **Buttons:**
   - Primary: bg `#4a9e6e`, white text, hover `#3d8a5e`
   - Outline: transparent bg, 1px border `#d0dcd0`, text `#3a4e3a`, hover bg `#f0f5f0`
   - All: `padding: 9px 18px`, `border-radius: 8px`, 13px weight-600, Inter font

7. **Upload Zone** — Dashed 2px border `#c8d8c8`, border-radius 12px, padding 60px 40px, centered. Upload icon in a 48px `#e8f0e8` rounded-square. Hover: border `#4a9e6e`, bg `#fafcfa`.

8. **Processing Animation** — Centered spinner (40px circle, 3px border, top border green), step list with numbered circles (22px, 2px border). Steps progress: pending (muted), active (pulsing, green border), done (solid green bg, white checkmark).

9. **Call Detail Layout** — Header with call title + metadata on left, action buttons on right. 2-column grid below: left = Compliance Scorecard panel, right = Transcript panel. Full-width Compliance Flags panel below.

10. **Scorecard Panel** — Header row with "Compliance Scorecard" title and large overall score (green if pass, red if fail). List of criteria with label on left, pass/fail/review badge on right. Items separated by light borders.

11. **Transcript Panel** — Scrollable (max-height 430px). Each line: timestamp in muted 11px, speaker name in bold (agent = green `#2d6e4a`, customer = purple `#5a5a8a`), then dialogue text. Inline compliance flags appear as red-left-bordered boxes (`#fef2f2` bg, 3px `#c0392b` left border) with 12px red warning text.

12. **Compliance Flags Panel** — Header shows "Compliance Flags (N)". Each flag: severity badge (HIGH = red, MEDIUM = amber) on left, then title (13px weight-600), description (12px muted), and timestamp (11px `#aabdaa`).

13. **Scorecards Grid** — 3-column grid, 16px gap. Each card: white with border, 20px padding, border-radius 10px. Title 14px weight-600, description 12px muted, meta line in green 12px weight-600 (e.g. "8 criteria · Active"). Last card is dashed "Create New Scorecard" with centered + icon. Cards have hover: green border + subtle shadow.

### Pages to Update

1. **Dashboard** (`/dashboard` or `/`) — Stats row (Total Calls, Scored, Avg Score, Pass Rate), two bar charts side-by-side (Calls Per Day, Compliance by Team), Recent Calls table
2. **Calls** (`/calls`) — Full-width table with Call ID, Agent, Customer, Duration, Score, Status, Flags, Date columns
3. **Upload** (`/upload`) — Upload drop zone, processing animation with 5 steps (Upload → Transcribe → Speakers → Scorecard → Report), auto-navigate to call detail on completion
4. **Call Detail** (`/calls/:id`) — 2-column layout with scorecard + transcript, full-width flags panel below
5. **Scorecards** (`/scorecards`) — 3-column grid of scorecard templates with "Create New" card

### Seed/Demo Data

Add a seed data file or API endpoint that populates the dashboard with realistic demo data so the app doesn't look empty. Include at least 8 calls with varied scores (58%-96%), agents (Sarah Mitchell, Tom Richards, Amy Blackwell, David Park, Rachel Kim), customers, and statuses (Pass/Fail/Review). Include one detailed call (#CG-4820, Tom Richards, Emma Wilson, 64% score, 4 compliance flags) with full transcript and flags for the call detail view.

### Important Notes

- Remove ALL emojis from the UI — use SVG icons only (stroke style, 18px, stroke-width 1.8)
- The theme is LIGHT — white sidebar, light green page background
- No dark mode
- Keep the existing routing and authentication — only change the visual design and add seed data
- If using Tailwind, override the default palette with these tokens. If using custom CSS, replace all existing colour values.
