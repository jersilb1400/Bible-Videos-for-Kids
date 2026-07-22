import { log } from "./logger.js";

// ANSI helpers
const CSI = "\x1b[";
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR_LINE = `${CSI}2K`;
const MOVE_UP = (n: number) => `${CSI}${n}A`;
const GREEN = `${CSI}32m`, YELLOW = `${CSI}33m`, CYAN = `${CSI}36m`, DIM = `${CSI}2m`, RESET = `${CSI}0m`;

const BOX = { TL: "┌", TR: "┐", BL: "└", BR: "┘", H: "─", V: "│" };

interface StageState {
  name: string;
  status: "pending" | "running" | "done" | "error";
  detail: string;
}

export class Backlot {
  private stages: StageState[] = [];
  private cost = 0;
  private title = "";
  private active = false;
  private stageLines: number;

  constructor(title: string, stages: string[], cost: number) {
    this.title = title;
    this.cost = cost;
    this.stages = stages.map((name) => ({ name, status: "pending" as const, detail: "" }));
    this.stageLines = stages.length;
    // Only activate in real terminals — skip in tests/pipes
    this.active = process.stdout.isTTY === true;
  }

  /** Show the board for the first time. */
  show(): void {
    this.active = this.active && process.stdout.isTTY === true;
    if (!this.active) return;
    process.stdout.write(HIDE_CURSOR);
    this.render();
    log.info("");
  }

  /** Mark a stage as running. */
  start(name: string): void {
    const s = this.stages.find((s) => s.name === name);
    if (s) { s.status = "running"; s.detail = ""; }
    this.render();
  }

  /** Mark a stage as done with detail. */
  done(name: string, detail = ""): void {
    const s = this.stages.find((s) => s.name === name);
    if (s) { s.status = "done"; s.detail = detail; }
    this.render();
  }

  /** Mark a stage as error. */
  error(name: string, detail = ""): void {
    const s = this.stages.find((s) => s.name === name);
    if (s) { s.status = "error"; s.detail = detail; }
    this.render();
  }

  /** Update cost estimate. */
  setCost(c: number): void {
    this.cost = c;
    this.render();
  }

  /** Hide the board. */
  hide(): void {
    if (!this.active) return;
    this.active = false;
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write("\n");
  }

  /** Render the board in-place. */
  private render(): void {
    if (!this.active) return;

    const TTY = process.stdout.isTTY;
    const w = TTY ? (process.stdout.columns || 80) : 80;
    const costStr = `$${this.cost.toFixed(2)}`;
    const header = ` ${this.title} `;
    const rhs = ` ${costStr} `;
    const midPad = Math.max(1, w - 2 - header.length - rhs.length);

    let out = "";

    // Move cursor back up if we've already drawn once
    if (this.stages[0]?.status !== "pending") {
      // Move up past the board (title line + stages + bottom line)
      out += MOVE_UP(this.stageLines + 2);
    }

    // Top border
    out += CLEAR_LINE + DIM + BOX.TL + BOX.H.repeat(header.length) + BOX.H.repeat(midPad)
      + BOX.H.repeat(rhs.length - 2) + BOX.TR + RESET + "\n";

    // Title + cost
    out += CLEAR_LINE + DIM + BOX.V + RESET + CYAN + header + RESET
      + " ".repeat(midPad - 2)
      + DIM + BOX.H.repeat(rhs.length - 2) + BOX.V + RESET + "\n";

    // Stages
    for (const s of this.stages) {
      out += CLEAR_LINE + DIM + BOX.V + RESET + " ";
      const icon = s.status === "done" ? GREEN + "✓" + RESET
        : s.status === "running" ? YELLOW + "⏳" + RESET
        : s.status === "error" ? CYAN + "✗" + RESET
        : DIM + "⬚" + RESET;
      out += icon + " " + s.name;
      if (s.detail) out += DIM + "  " + s.detail + RESET;
      const lineLen = icon.length + 1 + s.name.length + (s.detail ? 3 + s.detail.length : 0);
      out += " ".repeat(Math.max(1, w - lineLen - 2)) + DIM + BOX.V + RESET + "\n";
    }

    // Bottom border
    out += CLEAR_LINE + DIM + BOX.BL + BOX.H.repeat(w - 2) + BOX.BR + RESET;

    process.stdout.write(out);
  }
}