import type { Terminal as XTerm } from "@xterm/xterm";

import { TERMINAL_LONG_LINE_PRESSURE_BYTES } from "./terminalFlowConstants";

export type TerminalOutputPressureMode =
  | "normal"
  | "large-output"
  | "long-line"
  | "background";

export type TerminalOutputPressureSnapshot = {
  mode: TerminalOutputPressureMode;
  background: boolean;
  largeOutput: boolean;
  longLine: boolean;
  consecutiveUnbrokenBytes: number;
};

type TerminalOutputPressureState = {
  background: boolean;
  largeOutput: boolean;
  consecutiveUnbrokenBytes: number;
};

const pressureStates = new WeakMap<XTerm, TerminalOutputPressureState>();

const getOrCreateState = (term: XTerm): TerminalOutputPressureState => {
  let state = pressureStates.get(term);
  if (!state) {
    state = {
      background: false,
      largeOutput: false,
      consecutiveUnbrokenBytes: 0,
    };
    pressureStates.set(term, state);
  }
  return state;
};

const trailingUnbrokenLength = (data: string): number => {
  const lastNewline = Math.max(data.lastIndexOf("\n"), data.lastIndexOf("\r"));
  return lastNewline >= 0 ? data.length - lastNewline - 1 : data.length;
};

export const noteTerminalOutputPressureData = (
  term: XTerm,
  data: string,
): void => {
  if (!data) return;
  const state = getOrCreateState(term);
  state.largeOutput = data.length >= TERMINAL_LONG_LINE_PRESSURE_BYTES;
  if (data.includes("\n") || data.includes("\r")) {
    state.consecutiveUnbrokenBytes = trailingUnbrokenLength(data);
  } else {
    state.consecutiveUnbrokenBytes += data.length;
  }
};

export const setTerminalOutputPressureVisibility = (
  term: XTerm,
  visible: boolean,
): void => {
  getOrCreateState(term).background = !visible;
};

export const setTerminalOutputPressureLargeOutput = (
  term: XTerm,
  largeOutput: boolean,
): void => {
  getOrCreateState(term).largeOutput = largeOutput;
};

export const getTerminalOutputPressure = (
  term: XTerm,
): TerminalOutputPressureSnapshot => {
  const state = getOrCreateState(term);
  const longLine = state.consecutiveUnbrokenBytes >= TERMINAL_LONG_LINE_PRESSURE_BYTES;
  const mode: TerminalOutputPressureMode = state.background
    ? "background"
    : longLine
      ? "long-line"
      : state.largeOutput
        ? "large-output"
        : "normal";

  return {
    mode,
    background: state.background,
    largeOutput: state.largeOutput,
    longLine,
    consecutiveUnbrokenBytes: state.consecutiveUnbrokenBytes,
  };
};

export const resetTerminalOutputPressure = (term: XTerm): void => {
  pressureStates.delete(term);
};
