import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

/**
 * The app's entire icon set — hand-drawn outline glyphs on a 24x24 grid,
 * matching the EduM8 mark's own line weight rather than pulling in an
 * icon-font package. `react-native-svg` is already a dependency (used by
 * other brand assets), so this adds zero new packages and stays legible
 * at the small sizes the nav rail/drawer actually use (18–22px).
 *
 * Every icon takes the same props so call sites never have to think
 * about which icon they're placing — size and color always come from the
 * caller's theme, never hardcoded here. `style` is the escape hatch for
 * transforms (e.g. a rotated chevron).
 */
export interface IconProps {
  size?: number;
  color: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
}

const VIEWBOX = '0 0 24 24';

/** Speech-bubble outline — Chat nav item. */
export function ChatIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v10c0 .83-.67 1.5-1.5 1.5H9l-4 3.5v-3.5H5.5C4.67 16.5 4 15.83 4 15v-9.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Magnifying glass — echoes the EduM8 mark's own glass; Search nav item. */
export function SearchIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={strokeWidth} />
      <Line
        x1={15.3}
        y1={15.3}
        x2={20}
        y2={20}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Page with a folded corner — Documents nav item. */
export function DocumentsIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M6.5 3.5h7.5L18.5 8v12a.5.5 0 0 1-.5.5H6.5a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Path d="M14 3.5V8h4.5" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <Line
        x1={9}
        y1={12}
        x2={15.5}
        y2={12}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={9}
        y1={15.2}
        x2={15.5}
        y2={15.2}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Three sliders — Settings nav item. Reads clearly at 18–20px, unlike a gear. */
export function SettingsIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  const rows: [number, number][] = [
    [7, 8.5],
    [13, 12],
    [9, 15.5],
  ];
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      {rows.map(([, y]) => (
        <Line
          key={y}
          x1={4.5}
          y1={y}
          x2={19.5}
          y2={y}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      ))}
      {rows.map(([knobX, y]) => (
        <Circle key={`knob-${y}`} cx={knobX} cy={y} r={2} fill={color} />
      ))}
    </Svg>
  );
}

/** Sidebar rectangle with a divider — collapse/expand the drawer. `open`
 * flips which side the filled panel sits on, so the glyph itself hints
 * at the action (a filled left panel = "click to collapse it"). */
export function PanelIcon({
  size = 20,
  color,
  strokeWidth = 1.75,
  open = true,
}: IconProps & { open?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Rect
        x={3.5}
        y={4.5}
        width={17}
        height={15}
        rx={2.5}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <Line x1={9.5} y1={4.5} x2={9.5} y2={19.5} stroke={color} strokeWidth={strokeWidth} />
      {open && <Rect x={4.5} y={5.5} width={4} height={13} rx={1} fill={color} opacity={0.35} />}
    </Svg>
  );
}

/** Plain chevron, rotate via `style` at the call site (used for expand/collapse affordances that aren't the drawer itself). */
export function ChevronIcon({ size = 16, color, strokeWidth = 1.75, style }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none" style={style}>
      <Path
        d="M9 6l6 6-6 6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Plus — new chat / new project. */
export function PlusIcon({ size = 16, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Line
        x1={12}
        y1={5}
        x2={12}
        y2={19}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={5}
        y1={12}
        x2={19}
        y2={12}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Four-point sparkle — evidence-informed insight (login hero's third
 * benefit row: "Create evidence-informed lesson planning"). Distinct from
 * PlusIcon's even cross: uneven point lengths read as "insight/spark"
 * rather than "add". */
export function SparkleIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M12 3.5c.5 3.2 1.3 5 2.6 6.3 1.3 1.3 3.1 2.1 6.4 2.7-3.3.6-5.1 1.4-6.4 2.7-1.3 1.3-2.1 3.1-2.6 6.3-.5-3.2-1.3-5-2.6-6.3-1.3-1.3-3.1-2.1-6.4-2.7 3.3-.6 5.1-1.4 6.4-2.7 1.3-1.3 2.1-3.1 2.6-6.3Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Open eye — "show password" affordance. */
export function EyeIcon({ size = 16, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={strokeWidth} />
    </Svg>
  );
}

/** Eye with a slash — "hide password" affordance (paired with EyeIcon). */
export function EyeOffIcon({ size = 16, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M3.5 3.5l17 17M6.5 6.9C4.3 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.9 0 3.5-.6 4.8-1.4M10.2 5.7c.6-.1 1.2-.2 1.8-.2 6 0 9.5 6.5 9.5 6.5s-.8 1.5-2.3 3M9.9 9.9a3 3 0 0 0 4.2 4.2"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Three horizontal bars — open a drawer/overlay menu (narrow top bar). */
export function MenuIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      {[6.5, 12, 17.5].map((y) => (
        <Line
          key={y}
          x1={4}
          y1={y}
          x2={20}
          y2={y}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}

/** Three dots in a row — overflow/context menu trigger. */
export function MoreIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      {[5.5, 12, 18.5].map((x) => (
        <Circle key={x} cx={x} cy={12} r={1.6} fill={color} />
      ))}
    </Svg>
  );
}

/** Paperclip — attach a file to the composer. */
export function PaperclipIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M8.5 11.5 15 5a3.2 3.2 0 0 1 4.5 4.5l-8.8 8.8a5 5 0 0 1-7-7l8.7-8.7"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Framed picture with a spark — image generation in the composer. */
export function ImageIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Rect
        x={3.5}
        y={4.5}
        width={17}
        height={15}
        rx={2.5}
        stroke={color}
        strokeWidth={strokeWidth}
      />
      <Circle cx={9} cy={9.5} r={1.8} stroke={color} strokeWidth={strokeWidth} />
      <Path
        d="M4.5 17.5 10 12l4 4 3-3 3.5 3.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Tray with an up arrow — upload actions. */
export function UploadIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M12 14V4.5M8.5 8 12 4.5 15.5 8"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4.5 14v3.5A2 2 0 0 0 6.5 19.5h11a2 2 0 0 0 2-2V14"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Checkmark — checked state (project-membership checkboxes, password
 * requirement rows). */
export function CheckIcon({ size = 14, color, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M4.5 12.5l5 5 10-11"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Tray with a down arrow — download an attachment/generated image. */
export function DownloadIcon({ size = 14, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M12 4.5V14M8.5 10.5 12 14l3.5-3.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4.5 14v3.5A2 2 0 0 0 6.5 19.5h11a2 2 0 0 0 2-2V14"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Circular arrow — regenerate a response/image. */
export function RefreshIcon({ size = 14, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M19 6.5v4.5h-4.5M5 17.5V13h4.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M6 9.5A7 7 0 0 1 18.7 8M18 14.5A7 7 0 0 1 5.3 16"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Five-point star — "save to project" bookmark; `filled` mirrors the
 * saved/unsaved state (solid vs. outline), the standard favoriting idiom. */
export function StarIcon({
  size = 14,
  color,
  strokeWidth = 1.75,
  filled = false,
}: IconProps & { filled?: boolean }) {
  const path =
    'M12 4l2.35 4.9 5.35.75-3.9 3.75.95 5.35L12 16.2l-4.75 2.55.95-5.35-3.9-3.75 5.35-.75L12 4Z';
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d={path}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill={filled ? color : 'none'}
      />
    </Svg>
  );
}

/** Simple outline folder — Milestone 1 (Document Library / Folder
 * Management): folder rows on the Documents screen. */
export function FolderIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M3.5 6.5c0-.83.67-1.5 1.5-1.5h4l2 2h8c.83 0 1.5.67 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V6.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Plain document outline (no folded-corner/lines) — Milestone (Finder-style
 * Document Library): the default file glyph for a document row/card that
 * has no more specific file-type treatment, distinct in shape from
 * DocumentsIcon (the nav item) and FolderIcon (folders) so the two never
 * get confused at a glance in the same grid/list. */
export function FileIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Path d="M13.2 3.5V8h4.6" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </Svg>
  );
}

/** 2x2 grid of rounded squares — grid view toggle. */
export function GridIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Rect x={4} y={4} width={7} height={7} rx={1.5} stroke={color} strokeWidth={strokeWidth} />
      <Rect x={13} y={4} width={7} height={7} rx={1.5} stroke={color} strokeWidth={strokeWidth} />
      <Rect x={4} y={13} width={7} height={7} rx={1.5} stroke={color} strokeWidth={strokeWidth} />
      <Rect x={13} y={13} width={7} height={7} rx={1.5} stroke={color} strokeWidth={strokeWidth} />
    </Svg>
  );
}

/** Three left-aligned horizontal rows with a leading dot — list view toggle,
 * deliberately distinct from MenuIcon's three equal bars (that one triggers
 * an overlay; this one selects a layout). */
export function ListIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  const rows = [6, 12, 18];
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      {rows.map((y) => (
        <Circle key={`dot-${y}`} cx={4.5} cy={y} r={1.1} fill={color} />
      ))}
      {rows.map((y) => (
        <Line
          key={`row-${y}`}
          x1={8}
          y1={y}
          x2={20}
          y2={y}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}

/** Up/down arrow pair — sort direction toggle. `direction` fills in the
 * active arrow so the current order reads at a glance. */
export function SortIcon({
  size = 16,
  color,
  strokeWidth = 1.75,
  direction = 'asc',
}: IconProps & { direction?: 'asc' | 'desc' }) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M7 16.5V5M4 8.5 7 5l3 3.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={direction === 'asc' ? 1 : 0.4}
      />
      <Path
        d="M17 7.5V19M14 15.5l3 3.5 3-3.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={direction === 'desc' ? 1 : 0.4}
      />
    </Svg>
  );
}

/** Circled "i" — details/info panel toggle. */
export function InfoIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={strokeWidth} />
      <Circle cx={12} cy={8.3} r={1} fill={color} />
      <Line
        x1={12}
        y1={11}
        x2={12}
        y2={16.5}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** X — close a drawer/overlay/dialog. */
export function CloseIcon({ size = 18, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Line
        x1={6}
        y1={6}
        x2={18}
        y2={18}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={18}
        y1={6}
        x2={6}
        y2={18}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Small page with a pencil stroke across it — Frontend Milestone 3.2
 * (Research Evidence Workspace): the manual-note entry-type glyph, paired
 * with FileIcon (reused as the highlight/evidence entry-type glyph) so
 * the two entry kinds are distinguishable structurally at a glance
 * without leaning on color (M3.2 spec §19). */
export function NoteIcon({ size = 16, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M6.5 4h8l3 3v13a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5v-15a.5.5 0 0 1 .5-.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
      <Line
        x1={9}
        y1={11.5}
        x2={15}
        y2={11.5}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={9}
        y1={15}
        x2={13}
        y2={15}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Bookmark outline — Frontend Milestone 3.1 (Research Notes Workspace):
 * the "Notes" nav destination. Distinct in shape from FileIcon/FolderIcon
 * so a saved-research-excerpt collection never reads as "another document
 * list" at a glance. */
export function NotesIcon({ size = 20, color, strokeWidth = 1.75 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEWBOX} fill="none">
      <Path
        d="M6.5 4.5A1.5 1.5 0 0 1 8 3h8a1.5 1.5 0 0 1 1.5 1.5V20l-5.5-3.2L6.5 20V4.5Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}
